import { resolve } from "https://deno.land/std@0.86.0/path/win32.ts"
import { decoder } from "https://deno.land/std@0.87.0/encoding/utf8.ts"
import {
    HTTPOptions,
    HTTPSOptions,
    serve,
    Server,
    ServerRequest,
    serveTLS,
} from "https://deno.land/std@0.87.0/http/server.ts"
import { ConsoleLogger, Logger, LogLevel } from "https://deno.land/x/slack_logger@3.0.0/mod.ts"
import {
    InstallProvider,
    InstallProviderOptions,
    InstallURLOptions,
} from "https://deno.land/x/slack_oauth@3.0.0/mod.ts"

import App from "../App.ts"
import {
    ErrorCode,
    HTTPReceiverDeferredRequestError,
    ReceiverInconsistentStateError,
    ReceiverMultipleAckError,
} from "../errors.ts"
import { Receiver, ReceiverEvent } from "../types/index.ts"
import { verify as verifySlackAuthenticity } from "./verify-request.ts"

export interface HTTPReceiverOptions {
    signingSecret: string
    endpoints?: string | string[]
    logger?: Logger
    logLevel?: LogLevel
    processBeforeResponse?: boolean
    clientId?: string
    clientSecret?: string
    stateSecret?: InstallProviderOptions["stateSecret"] // required when using default stateStore
    installationStore?: InstallProviderOptions["installationStore"] // default MemoryInstallationStore
    scopes?: InstallURLOptions["scopes"]
    installerOptions?: HTTPReceiverInstallerOptions
}

export interface HTTPReceiverInstallerOptions {
    installPath?: string
    redirectUriPath?: string
    stateStore?: InstallProviderOptions["stateStore"] // default ClearStateStore
    authVersion?: InstallProviderOptions["authVersion"] // default 'v2'
    clientOptions?: InstallProviderOptions["clientOptions"]
    authorizationUrl?: InstallProviderOptions["authorizationUrl"]
    metadata?: InstallURLOptions["metadata"]
    userScopes?: InstallURLOptions["userScopes"]
    callbacks?: {
        failure?: (req: ServerRequest) => Promise<void>
        success?: (req: ServerRequest) => Promise<void>
    }
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class HTTPReceiver implements Receiver {
    private endpoints: string[]

    private signingSecret: string

    private processBeforeResponse: boolean

    private app?: App

    public requestListener: (req: ServerRequest) => void | Promise<void>

    private server?: Server

    public installer?: InstallProvider

    private installPath?: string // always defined when installer is defined

    private installRedirectUriPath?: string // always defined when installer is defined

    private installUrlOptions?: InstallURLOptions // always defined when installer is defined

    private installerRedirectOptions?: {
        failure?: (req: ServerRequest) => Promise<void>
        success?: (req: ServerRequest) => Promise<void>
    }

    private logger: Logger

    constructor({
        signingSecret = "",
        endpoints = ["/slack/events"],
        logger = undefined,
        logLevel = LogLevel.INFO,
        processBeforeResponse = false,
        clientId = undefined,
        clientSecret = undefined,
        stateSecret = undefined,
        installationStore = undefined,
        scopes = undefined,
        installerOptions = {},
    }: HTTPReceiverOptions) {
        // Initialize instance variables, substituting defaults for each value
        this.signingSecret = signingSecret
        this.processBeforeResponse = processBeforeResponse
        this.logger = logger
            ?? (() => {
                const defaultLogger = new ConsoleLogger()
                defaultLogger.setLevel(logLevel)
                return defaultLogger
            })()
        this.endpoints = Array.isArray(endpoints) ? endpoints : [endpoints]

        // Initialize InstallProvider when it's required options are provided
        if (
            clientId !== undefined
            && clientSecret !== undefined
            && (stateSecret !== undefined || installerOptions.stateStore !== undefined)
        ) {
            this.installer = new InstallProvider({
                clientId,
                clientSecret,
                stateSecret,
                installationStore,
                logger,
                logLevel,
                stateStore: installerOptions.stateStore,
                authVersion: installerOptions.authVersion,
                clientOptions: installerOptions.clientOptions,
                authorizationUrl: installerOptions.authorizationUrl,
            })

            // Store the remaining instance variables that are related to using the InstallProvider
            this.installPath = installerOptions.installPath ?? "/slack/install"
            this.installRedirectUriPath = installerOptions.redirectUriPath
                ?? "/slack/oauth_redirect"
            this.installUrlOptions = {
                scopes: scopes ?? [],
                userScopes: installerOptions.userScopes,
                metadata: installerOptions.metadata,
            }
            this.installerRedirectOptions = installerOptions.callbacks
        }

        // Assign the requestListener property by binding the unboundRequestListener to this instance
        this.requestListener = this.unboundRequestListener.bind(this)
    }

    public init(app: App) {
        this.app = app
    }

    public async start(options: HTTPOptions | HTTPSOptions): Promise<Server> {
        if (this.server !== undefined) {
            throw new ReceiverInconsistentStateError(
                "The receiver cannot be started because it was already started.",
            )
        }

        this.server = isHTTPSOptions(options)
            ? serveTLS(options)
            : serve(options)

        const httpReciever = this

        async function handleServerRequests() {
            for await (const req of httpReciever.server!) {
                try {
                    httpReciever.requestListener(req)
                } catch (error) {
                    if (error.code === ErrorCode.HTTPReceiverDeferredRequestError) {
                        httpReciever.logger.info("An unhandled request was ignored")
                        req.respond({
                            status: 404,
                            body: "Not Found",
                        })
                    } else {
                        httpReciever.logger.error("An unexpected error was encountered")
                        httpReciever.logger.debug(`Error details: ${error}`)
                        req.respond({
                            status: 500,
                            body: "Internal Server Error",
                        })
                    }
                }
            }
        }

        handleServerRequests()
        return this.server
    }

    public stop(): void {
        if (this.server === undefined) {
            throw new ReceiverInconsistentStateError(
                "The receiver cannot be stopped because it was not started.",
            )
        }

        this.server.close()
        this.server = undefined
    }

    private unboundRequestListener(req: ServerRequest) {
        // Route the request
        // NOTE: the domain and scheme of the following URL object are not necessarily accurate. The URL object is only
        // meant to be used to parse the path and query
        const { pathname: path } = new URL(
            req.url,
            `http://${req.headers.get("host")}`,
        )

        const method = req.method!.toUpperCase()

        if (this.endpoints.includes(path) && method === "POST") {
            // Handle incoming ReceiverEvent
            return this.handleIncomingEvent(req)
        }

        if (this.installer !== undefined && method === "GET") {
            // When installer is defined then installPath and installRedirectUriPath are always defined
            const [installPath, installRedirectUriPath] = [
                this.installPath!,
                this.installRedirectUriPath!,
            ]

            if (path === installPath) {
                // Render installation path (containing Add to Slack button)
                return this.handleInstallPathRequest(req)
            }
            if (path === installRedirectUriPath) {
                // Handle OAuth callback request (to exchange authorization grant for a new access token)
                return this.handleInstallRedirectRequest(req)
            }
        }

        // If the request did not match the previous conditions, an error is thrown. The error can be caught by the
        // the caller in order to defer to other routing logic (similar to calling `next()` in connect middleware).
        throw new HTTPReceiverDeferredRequestError(
            "Unhandled HTTP request",
            req,
        )
    }

    private handleIncomingEvent(req: ServerRequest) {
        // Wrapped in an async closure for ease of using await
        ;(async () => {
            let body: any

            // Verify authenticity
            try {
                await verifySlackAuthenticity({ signingSecret: this.signingSecret }, req)
            } catch (err) {
                this.logger.warn(`Request verification failed: ${err.message}`)
                return await req.respond({
                    status: 401,
                    body: "Unauthorized",
                })
            }

            // Parse request body
            // The object containing the parsed body is not exposed to the caller. It is preferred to reduce mutations to the
            // req object, so that its as reusable as possible. Later, we should consider adding an option for assigning the
            // parsed body to `req.body`, as this convention has been established by the popular `body-parser` package.
            try {
                body = parseBody(req)
            } catch (err) {
                this.logger.warn(`Malformed request body: ${err.message}`)
                return await req.respond({
                    status: 400,
                    body: "Bad Request",
                })
            }

            // Handle SSL checks
            if (body.ssl_check) {
                return await req.respond({
                    status: 200,
                    body: "OK",
                })
            }

            // Handle URL verification
            if (body.type === "url_verification") {
                return await req.respond({
                    status: 200,
                    headers: new Headers({
                        "content-type": "application/json",
                    }),
                    body: JSON.stringify({ challenge: body.challenge }),
                })
            }

            // Setup ack timeout warning
            let isAcknowledged = false
            setTimeout(() => {
                if (!isAcknowledged) {
                    this.logger.error(
                        "An incoming event was not acknowledged within 3 seconds. "
                            + "Ensure that the ack() argument is called in a listener.",
                    )
                }
            }, 3001)

            // Structure the ReceiverEvent
            let storedResponse
            const event: ReceiverEvent = {
                body,
                ack: async (response) => {
                    this.logger.debug("ack() begin")
                    if (isAcknowledged) {
                        throw new ReceiverMultipleAckError()
                    }
                    isAcknowledged = true
                    if (this.processBeforeResponse) {
                        if (!response) {
                            storedResponse = ""
                        } else {
                            storedResponse = response
                        }
                        this.logger.debug("ack() response stored")
                    } else {
                        if (!response) {
                            await req.respond({
                                status: 200,
                                body: "OK",
                            })
                        } else if (typeof response === "string") {
                            await req.respond({
                                status: 200,
                                body: response,
                            })
                        } else {
                            await req.respond({
                                status: 200,
                                headers: new Headers({
                                    "content-type": "application/json",
                                }),
                                body: JSON.stringify(response),
                            })
                        }
                        this.logger.debug("ack() response sent")
                    }
                },
            }

            // Send the event to the app for processing
            try {
                await this.app?.processEvent(event)
                if (storedResponse !== undefined) {
                    if (typeof storedResponse === "string") {
                        await req.respond({
                            status: 200,
                            body: storedResponse,
                        })
                    } else {
                        await req.respond({
                            status: 200,
                            headers: new Headers({
                                "content-type": "application/json",
                            }),
                            body: JSON.stringify(storedResponse),
                        })
                    }
                    this.logger.debug("stored response sent")
                }
            } catch (err) {
                this.logger.error(
                    "An unhandled error occurred while Bolt processed an event",
                )
                this.logger.debug(
                    `Error details: ${err}, storedResponse: ${storedResponse}`,
                )
                await req.respond({
                    status: 500,
                    body: "Internal Server Error",
                })
            }
        })()
    }

    private handleInstallPathRequest(req: ServerRequest) {
        // Wrapped in an async closure for ease of using await
        ;(async () => {
            // NOTE: Skipping some ceremony such as content negotiation, setting informative headers, etc. These may be nice
            // to have for completeness, but there's no clear benefit to adding them, so just keeping things simple. If a
            // user desires a more custom page, they can always call `App.installer.generateInstallUrl()` and render their
            // own page instead of using this one.
            try {
                // This function is only called from within unboundRequestListener after checking that installer is defined, and
                // when installer is defined then installUrlOptions is always defined too.
                const [installer, installUrlOptions] = [
                    this.installer!,
                    this.installUrlOptions!,
                ]

                // Generate the URL for the "Add to Slack" button.
                const url = await installer.generateInstallUrl(installUrlOptions)

                // Generate HTML response body
                const body = htmlForInstallPath(url)

                // Serve a basic HTML page including the "Add to Slack" button.
                // Regarding headers:
                // - Content-Type is usually automatically detected by browsers
                // - Content-Length is not used because Transfer-Encoding='chunked' is automatically used.
                req.respond({
                    status: 200,
                    body,
                })
            } catch (err) {
                this.logger.error(
                    "An unhandled error occurred while Bolt processed a request to the installation path",
                )
                this.logger.debug(`Error details: ${err}`)
            }
        })()
    }

    private async handleInstallRedirectRequest(req: ServerRequest) {
        // This function is only called from within unboundRequestListener after checking that installer is defined, and
        // when installer is defined then installCallbackOptions is always defined too.
        const reqURL = new URL(req.url)

        try {
            const result = await this.installer!.handle(
                reqURL.searchParams.get("body")!,
                reqURL.searchParams.get("state")!,
            )

            if (this.installerRedirectOptions && this.installerRedirectOptions.success) {
                await this.installerRedirectOptions.success(req)
            } else {
                await req.respond({
                    status: 200,
                    body: result,
                })
            }
        } catch (e) {
            if (this.installerRedirectOptions && this.installerRedirectOptions.failure) {
                await this.installerRedirectOptions.failure(req)
            } else {
                await req.respond({
                    status: 500,
                    body: e.message,
                })
            }
        }
    }
}

// Helpers4

function isHTTPSOptions(options: HTTPSOptions | HTTPOptions): options is HTTPSOptions {
    return "keyFile" in options || "certFile" in options
}

async function parseBody(req: ServerRequest) {
    const bodyAsString = decoder.decode(await Deno.readAll(req.body))
    const contentType = req.headers.get("content-type")
    if (contentType === "application/x-www-form-urlencoded") {
        const parsedQs = new URLSearchParams(bodyAsString)
        const payload = parsedQs.get("payload")
        if (typeof payload === "string") {
            return JSON.parse(payload)
        }

        const result: any = {}

        for (const [key, value] of parsedQs.entries()) {
            result[key] = value
        }

        return result
    }
    return JSON.parse(bodyAsString)
}

function htmlForInstallPath(addToSlackUrl: string) {
    return `<html>
      <body>
        <a href=${addToSlackUrl}>
          <img
            alt="Add to Slack"
            height="40"
            width="139"
            src="https://platform.slack-edge.com/img/add_to_slack.png"
            srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
          />
        </a>
      </body>
    </html>`
}

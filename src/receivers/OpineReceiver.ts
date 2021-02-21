import { ConsoleLogger, Logger, LogLevel } from "https://deno.land/x/slack_logger@3.0.0/mod.ts"
import {
    InstallProvider,
    InstallProviderOptions,
    InstallURLOptions,
} from "https://deno.land/x/slack_oauth@3.0.0/mod.ts"

import { hmac as createHmac } from "https://deno.land/x/god_crypto/hmac.ts"
import {
    Opine,
    opine as createOpine,
    ParamsDictionary,
    Request as OpineRequest,
    RequestHandler,
    Response as OpineResponse,
    Router as createRouter,
} from "https://deno.land/x/opine@1.1.0/mod.ts"

import type { HTTPOptions, HTTPSOptions, Server } from "https://deno.land/std@0.87.0/http/server.ts"

import { decoder } from "https://deno.land/std@0.83.0/encoding/utf8.ts"
import App from "../App.ts"
import { ReceiverAuthenticityError, ReceiverInconsistentStateError, ReceiverMultipleAckError } from "../errors.ts"
import { AnyMiddlewareArgs, Receiver, ReceiverEvent } from "../types/index.ts"

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface OpineReceiverOptions {
    signingSecret: string
    logger?: Logger
    logLevel?: LogLevel
    endpoints?:
        | string
        | {
            [endpointType: string]: string
        }
    processBeforeResponse?: boolean
    clientId?: string
    clientSecret?: string
    stateSecret?: InstallProviderOptions["stateSecret"] // required when using default stateStore
    installationStore?: InstallProviderOptions["installationStore"] // default MemoryInstallationStore
    scopes?: InstallURLOptions["scopes"]
    opineInstallerOptions?: OpineInstallerOptions
}

// Additional Installer Options
interface OpineInstallerOptions {
    stateStore?: InstallProviderOptions["stateStore"] // default ClearStateStore
    authVersion?: InstallProviderOptions["authVersion"] // default 'v2'
    metadata?: InstallURLOptions["metadata"]
    installPath?: string
    redirectUriPath?: string
    userScopes?: InstallURLOptions["userScopes"]
    clientOptions?: InstallProviderOptions["clientOptions"]
    authorizationUrl?: InstallProviderOptions["authorizationUrl"]
    callbacks?: {
        failure?: (req: OpineRequest<ParamsDictionary, any, any>, res: OpineResponse<any>) => Promise<void>
        success?: (req: OpineRequest<ParamsDictionary, any, any>, res: OpineResponse<any>) => Promise<void>
    }
}

/**
 * Receives HTTP requests with Events, Slash Commands, and Actions
 */
export default class OpineReceiver implements Receiver {
    /* Opine app */
    public app: Opine

    private server?: Server

    private bolt: App | undefined

    private logger: Logger

    private processBeforeResponse: boolean

    public router

    public installer: InstallProvider | undefined = undefined

    private installerRedirectOptions?: {
        failure?: (req: OpineRequest<ParamsDictionary, any, any>, res: OpineResponse<any>) => Promise<void>
        success?: (req: OpineRequest<ParamsDictionary, any, any>, res: OpineResponse<any>) => Promise<void>
    }

    constructor({
        signingSecret = "",
        logger = undefined,
        logLevel = LogLevel.INFO,
        endpoints = { events: "/slack/events" },
        processBeforeResponse = false,
        clientId = undefined,
        clientSecret = undefined,
        stateSecret = undefined,
        installationStore = undefined,
        scopes = undefined,
        opineInstallerOptions: opineInstallerOptions = {},
    }: OpineReceiverOptions) {
        this.app = createOpine()

        if (typeof logger !== "undefined") {
            this.logger = logger
        } else {
            this.logger = new ConsoleLogger()
            this.logger.setLevel(logLevel)
        }

        if (typeof logger !== "undefined") {
            this.logger = logger
        } else {
            this.logger = new ConsoleLogger()
            this.logger.setLevel(logLevel)
        }

        const opineMiddleware: RequestHandler[] = [
            verifySignatureAndParseRawBody(this.logger, signingSecret),
            respondToSslCheck,
            respondToUrlVerification,
            this.requestHandler.bind(this),
        ]

        this.processBeforeResponse = processBeforeResponse

        const endpointList = typeof endpoints === "string"
            ? [endpoints]
            : Object.values(endpoints)
        this.router = createRouter()
        endpointList.forEach((endpoint) => {
            this.router.post(endpoint, ...opineMiddleware)
        })

        if (
            clientId !== undefined
            && clientSecret !== undefined
            && (stateSecret !== undefined || opineInstallerOptions.stateStore !== undefined)
        ) {
            this.installer = new InstallProvider({
                clientId,
                clientSecret,
                stateSecret,
                installationStore,
                logLevel,
                logger, // pass logger that was passed in constructor, not one created locally
                stateStore: opineInstallerOptions.stateStore,
                authVersion: opineInstallerOptions.authVersion!,
                clientOptions: opineInstallerOptions.clientOptions,
                authorizationUrl: opineInstallerOptions.authorizationUrl,
            })

            this.installerRedirectOptions = opineInstallerOptions.callbacks
        }

        // Add OAuth routes to receiver
        if (this.installer !== undefined) {
            const redirectUriPath = opineInstallerOptions.redirectUriPath === undefined
                ? "/slack/oauth_redirect"
                : opineInstallerOptions.redirectUriPath
            this.router.use(redirectUriPath, async (req, res) => {
                const reqURL = new URL(req.url)

                try {
                    const result = await this.installer!.handle(
                        reqURL.searchParams.get("code")!,
                        reqURL.searchParams.get("state")!,
                    )

                    if (this.installerRedirectOptions && this.installerRedirectOptions.success) {
                        await this.installerRedirectOptions.success(req, res)
                    } else {
                        res.setStatus(200).send(result)
                    }
                } catch (e) {
                    if (this.installerRedirectOptions && this.installerRedirectOptions.failure) {
                        await this.installerRedirectOptions.failure(req, res)
                    } else {
                        res.setStatus(500).send(e.message)
                    }
                }
            })

            const installPath = opineInstallerOptions.installPath === undefined
                ? "/slack/install"
                : opineInstallerOptions.installPath
            this.router.get(installPath, async (_req, res, next) => {
                try {
                    const url = await this.installer!.generateInstallUrl({
                        metadata: opineInstallerOptions.metadata,
                        scopes: scopes!,
                        userScopes: opineInstallerOptions.userScopes,
                    })
                    res.send(
                        `<a href=${url}><img alt=""Add to Slack"" height="40" width="139"
              src="https://platform.slack-edge.com/img/add_to_slack.png"
              srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,
              https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>`,
                    )
                } catch (error) {
                    next(error)
                }
            })
        }

        this.app.use(this.router)
    }

    private async requestHandler(
        req: OpineRequest<ParamsDictionary, any, any>,
        res: OpineResponse<any>,
    ): Promise<void> {
        let isAcknowledged = false
        setTimeout(() => {
            if (!isAcknowledged) {
                this.logger.error(
                    "An incoming event was not acknowledged within 3 seconds. Ensure that the ack() argument is called in a listener.",
                )
            }
        }, 3001)

        let storedResponse
        const event: ReceiverEvent = {
            body: JSON.parse(decoder.decode(await Deno.readAll(req.raw))),
            ack: async (response): Promise<void> => {
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
                        res.send("")
                    } else if (typeof response === "string") {
                        res.send(response)
                    } else {
                        res.json(response)
                    }
                    this.logger.debug("ack() response sent")
                }
            },
        }

        try {
            await this.bolt?.processEvent(event)
            if (storedResponse !== undefined) {
                if (typeof storedResponse === "string") {
                    res.send(storedResponse)
                } else {
                    res.json(storedResponse)
                }
                this.logger.debug("stored response sent")
            }
        } catch (err) {
            res.sendStatus(500)
            throw err
        }
    }

    public init(bolt: App): void {
        this.bolt = bolt
    }

    public start(portOrOptions: HTTPOptions | HTTPSOptions): Server {
        if (this.server !== undefined) {
            throw new ReceiverInconsistentStateError(
                "The receiver cannot be started because it was already started.",
            )
        }

        this.server = this.app.listen(portOrOptions) as unknown as Server
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
}

export const respondToSslCheck: RequestHandler = (req, res, next) => {
    if (req.body && req.body.ssl_check) {
        res.send()
        return
    }
    next()
}

export const respondToUrlVerification: RequestHandler = (req, res, next) => {
    if (req.body && req.body.type && req.body.type === "url_verification") {
        res.json({ challenge: req.body.challenge })
        return
    }
    next()
}

/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
export function verifySignatureAndParseRawBody(
    logger: Logger,
    signingSecret: string,
): RequestHandler {
    return async (req, res, next) => {
        // TODO (?)
        // On some environments like GCP (Google Cloud Platform),
        // req.body can be pre-parsed and be passed as req.rawBody here

        // *** Parsing body ***
        // As the verification passed, parse the body as an object and assign it to req.body
        // Following middlewares can expect `req.body` is already a parsed one.

        try {
            // This handler parses `req.body` or `req.rawBody`(on Google Could Platform)
            // and overwrites `req.body` with the parsed JS object.
            req.body = verifySignatureAndParseBody(
                signingSecret,
                req.raw,
                req.headers,
            )
        } catch (error) {
            if (error) {
                if (error instanceof ReceiverAuthenticityError) {
                    logError(logger, "Request verification failed", error)
                    return res.sendStatus(401)
                }

                logError(logger, "Parsing request body failed", error)
                return res.sendStatus(400)
            }
        }

        return next()
    }
}

function logError(logger: Logger, message: string, error: any): void {
    const logMessage = "code" in error
        ? `${message} (code: ${error.code}, message: ${error.message})`
        : `${message} (error: ${error})`
    logger.warn(logMessage)
}

function verifyRequestSignature(
    signingSecret: string,
    body: Deno.Reader,
    signature: string | undefined,
    requestTimestamp: string | undefined,
): void {
    if (signature === undefined || requestTimestamp === undefined) {
        throw new ReceiverAuthenticityError(
            "Slack request signing verification failed. Some headers are missing.",
        )
    }

    const ts = Number(requestTimestamp)
    if (isNaN(ts)) {
        throw new ReceiverAuthenticityError(
            "Slack request signing verification failed. Timestamp is invalid.",
        )
    }

    // Divide current date to match Slack ts format
    // Subtract 5 minutes from current time
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5

    if (ts < fiveMinutesAgo) {
        throw new ReceiverAuthenticityError(
            "Slack request signing verification failed. Timestamp is too old.",
        )
    }

    const [version, hash] = signature.split("=")
    const hmac = createHmac("sha256", signingSecret, `${version}:${ts}:${body}`)

    // TODO Time safe compare (?)
    if (hash === hmac.hex()) {
        throw new ReceiverAuthenticityError(
            "Slack request signing verification failed. Signature mismatch.",
        )
    }
}

/**
 * This request handler has two responsibilities:
 * - Verify the request signature
 * - Parse request.body and assign the successfully parsed object to it.
 */
async function verifySignatureAndParseBody(
    signingSecret: string,
    body: Deno.Reader,
    headers: Record<string, any>,
): Promise<AnyMiddlewareArgs["body"]> {
    // *** Request verification ***
    const {
        "x-slack-signature": signature,
        "x-slack-request-timestamp": requestTimestamp,
        "content-type": contentType,
    } = headers

    verifyRequestSignature(signingSecret, body, signature, requestTimestamp)
    return parseRequestBody(decoder.decode(await Deno.readAll(body)), contentType)
}

function parseRequestBody(
    stringBody: string,
    contentType: string | undefined,
): AnyMiddlewareArgs["body"] {
    if (contentType === "application/x-www-form-urlencoded") {
        const parsedBody = new URLSearchParams(stringBody)

        const payload = parsedBody.get("payload")
        if (typeof payload === "string") {
            return JSON.parse(payload)
        }

        const result: any = {}

        for (const [key, value] of parsedBody.entries()) {
            result[key] = value
        }

        return result
    }

    return JSON.parse(stringBody)
}

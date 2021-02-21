import { ConsoleLogger, Logger, LogLevel } from "../../deps.ts"
import { SocketModeClient } from "../../deps.ts"
import { WebAPICallResult } from "../../deps.ts"
import { serve, ServerRequest } from "../../deps.ts"
import { InstallProvider, InstallProviderOptions, InstallURLOptions } from "../../deps.ts"
import App from "../App.ts"
import { Receiver, ReceiverEvent } from "../types/index.ts"

// TODO: we throw away the key names for endpoints, so maybe we should use this interface. is it better for migrations?
// if that's the reason, let's document that with a comment.
export interface SocketModeReceiverOptions {
    logger?: Logger
    logLevel?: LogLevel
    clientId?: string
    clientSecret?: string
    stateSecret?: InstallProviderOptions["stateSecret"] // required when using default stateStore
    installationStore?: InstallProviderOptions["installationStore"] // default MemoryInstallationStore
    scopes?: InstallURLOptions["scopes"]
    installerOptions?: InstallerOptions
    appToken: string // App Level Token
}

// Additional Installer Options
interface InstallerOptions {
    stateStore?: InstallProviderOptions["stateStore"] // default ClearStateStore
    authVersion?: InstallProviderOptions["authVersion"] // default 'v2'
    metadata?: InstallURLOptions["metadata"]
    installPath?: string
    redirectUriPath?: string
    userScopes?: InstallURLOptions["userScopes"]
    clientOptions?: InstallProviderOptions["clientOptions"]
    authorizationUrl?: InstallProviderOptions["authorizationUrl"]
    port?: number // used to create a server when doing OAuth,
    callbacks?: {
        failure?: (req: ServerRequest) => Promise<void>
        success?: (req: ServerRequest) => Promise<void>
    }
}

/**
 * Receives Events, Slash Commands, and Actions of a web socket connection
 */
export default class SocketModeReceiver implements Receiver {
    /* Express app */
    public client: SocketModeClient

    private app: App | undefined

    private logger: Logger

    public installer: InstallProvider | undefined = undefined

    private installerRedirectOptions?: {
        failure?: (req: ServerRequest) => Promise<void>
        success?: (req: ServerRequest) => Promise<void>
    }

    constructor({
        appToken,
        logger = undefined,
        logLevel = LogLevel.INFO,
        clientId = undefined,
        clientSecret = undefined,
        stateSecret = undefined,
        installationStore = undefined,
        scopes = undefined,
        installerOptions = {},
    }: SocketModeReceiverOptions) {
        this.client = new SocketModeClient({
            appToken,
            logLevel,
            logger,
            clientOptions: installerOptions.clientOptions,
        })

        if (typeof logger !== "undefined") {
            this.logger = logger
        } else {
            this.logger = new ConsoleLogger()
            this.logger.setLevel(logLevel)
        }

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
                logLevel,
                logger, // pass logger that was passed in constructor, not one created locally
                stateStore: installerOptions.stateStore,
                authVersion: installerOptions.authVersion!,
                clientOptions: installerOptions.clientOptions,
                authorizationUrl: installerOptions.authorizationUrl,
            })

            this.installerRedirectOptions = installerOptions.callbacks
        }

        // Add OAuth routes to receiver
        if (this.installer !== undefined) {
            // use default or passed in redirect path
            const redirectUriPath = installerOptions.redirectUriPath === undefined
                ? "/slack/oauth_redirect"
                : installerOptions.redirectUriPath

            // use default or passed in installPath
            const installPath = installerOptions.installPath === undefined
                ? "/slack/install"
                : installerOptions.installPath

            const port = installerOptions.port === undefined
                ? 3000
                : installerOptions.port
            this.logger.debug(`listening on port ${port} for OAuth`)
            this.logger.debug(
                `Go to http://localhost:${port}${installPath} to initiate OAuth flow`,
            )

            const socketModeReciever = this

            async function handleOauth() {
                const server = serve({ port: 8080 })

                for await (const req of server) {
                    if (req.url !== undefined && req.url.startsWith(redirectUriPath)) {
                        const reqURL = new URL(req.url)
                        try {
                            const result = await socketModeReciever.installer!.handle(
                                reqURL.searchParams.get("code")!,
                                reqURL.searchParams.get("state")!,
                            )

                            if (
                                socketModeReciever.installerRedirectOptions
                                && socketModeReciever.installerRedirectOptions.success
                            ) {
                                await socketModeReciever.installerRedirectOptions.success(req)
                            } else {
                                await req.respond({
                                    status: 200,
                                    body: result,
                                })
                            }
                        } catch (e) {
                            if (
                                socketModeReciever.installerRedirectOptions
                                && socketModeReciever.installerRedirectOptions.failure
                            ) {
                                await socketModeReciever.installerRedirectOptions.failure(req)
                            } else {
                                await req.respond({
                                    status: 500,
                                    body: e.message,
                                })
                            }
                        }
                    } else if (req.url !== undefined && req.url.startsWith(installPath)) {
                        try {
                            const url = await socketModeReciever.installer!.generateInstallUrl({
                                metadata: installerOptions.metadata,
                                scopes: scopes!,
                                userScopes: installerOptions.userScopes,
                            })

                            await req.respond({
                                status: 200,
                                body: `<html><body><a href=${url}><img alt=""Add to Slack"" height="40" width="139"
                src="https://platform.slack-edge.com/img/add_to_slack.png"
                srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x,
                https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a></body></html>`,
                            })
                        } catch (err) {
                            throw new Error(err)
                        }
                    } else {
                        socketModeReciever.logger.error(`Tried to reach ${req.url} which isn't a`)
                        // Return 404 because we don't support route
                        await req.respond({
                            status: 404,
                            body: `route ${req.url} doesn't exist!`,
                        })
                    }
                }
            }

            handleOauth()
        }

        this.client.addEventListener("slack_event", async ({ detail: { ack, body } }) => {
            const event: ReceiverEvent = {
                body,
                ack,
            }
            await this.app?.processEvent(event)
        })
    }

    public init(app: App): void {
        this.app = app
    }

    public async start(): Promise<WebAPICallResult> {
        // start socket mode client
        return await this.client.start()
    }

    public async stop(): Promise<void> {
        await this.client.disconnect()
    }
}

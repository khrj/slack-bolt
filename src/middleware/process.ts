import { Logger } from "https://deno.land/x/slack_logger@3.0.0/mod.ts"
import { WebClient } from "https://deno.land/x/slack_web_api@1.0.1/mod.ts"
import { AnyMiddlewareArgs, Context, Middleware } from "../types/index.ts"

export async function processMiddleware(
    middleware: Middleware<AnyMiddlewareArgs>[],
    initialArgs: AnyMiddlewareArgs,
    context: Context,
    client: WebClient,
    logger: Logger,
    last: () => Promise<void>,
): Promise<void> {
    let lastCalledMiddlewareIndex = -1

    async function invokeMiddleware(
        toCallMiddlewareIndex: number,
    ): ReturnType<Middleware<AnyMiddlewareArgs>> {
        if (lastCalledMiddlewareIndex >= toCallMiddlewareIndex) {
            // TODO: use a coded error
            throw Error("next() called multiple times")
        }

        if (toCallMiddlewareIndex < middleware.length) {
            lastCalledMiddlewareIndex = toCallMiddlewareIndex
            return middleware[toCallMiddlewareIndex]({
                next: () => invokeMiddleware(toCallMiddlewareIndex + 1),
                ...initialArgs,
                context,
                client,
                logger,
            })
        }

        return last()
    }

    return invokeMiddleware(0)
}

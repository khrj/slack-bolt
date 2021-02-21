import { Logger, WebClient } from "../../deps.ts"
import { AnyMiddlewareArgs, Middleware, StringIndexed } from "../types/index.ts"

export function processMiddleware(
    middleware: Middleware<AnyMiddlewareArgs>[],
    initialArgs: AnyMiddlewareArgs,
    context: StringIndexed,
    client: WebClient,
    logger: Logger,
    last: () => Promise<void>,
): Promise<void> {
    let lastCalledMiddlewareIndex = -1

    function invokeMiddleware(
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

import { Logger } from "../../deps.ts"
import { WebClient } from "../../deps.ts"
import { SlackActionMiddlewareArgs } from "./actions/index.ts"
import { SlackCommandMiddlewareArgs } from "./command/index.ts"
import { SlackEventMiddlewareArgs } from "./events/index.ts"
import { StringIndexed } from "./helpers.ts"
import { SlackOptionsMiddlewareArgs } from "./options/index.ts"
import { SlackShortcutMiddlewareArgs } from "./shortcuts/index.ts"
import { SlackViewMiddlewareArgs } from "./view/index.ts"

// TODO: rename this to AnyListenerArgs, and all the constituent types
export type AnyMiddlewareArgs =
    | SlackEventMiddlewareArgs
    | SlackActionMiddlewareArgs
    | SlackCommandMiddlewareArgs
    | SlackOptionsMiddlewareArgs
    | SlackViewMiddlewareArgs
    | SlackShortcutMiddlewareArgs

export interface AllMiddlewareArgs {
    context: Context
    logger: Logger
    client: WebClient
    // TODO: figure out how to make next non-optional
    next?: NextFn
}

// NOTE: Args should extend AnyMiddlewareArgs, but because of contravariance for function types, including that as a
// constraint would mess up the interface of App#event(), App#message(), etc.
export interface Middleware<Args> {
    (args: Args & AllMiddlewareArgs): Promise<void>
}

export interface Context extends StringIndexed {}

export type NextFn = () => Promise<void>

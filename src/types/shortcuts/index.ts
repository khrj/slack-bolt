// export * from './message-action';
export * from "./global-shortcut.ts"
export * from "./message-shortcut.ts"

import { AckFn, RespondFn, SayFn } from "../utilities.ts"
import { GlobalShortcut } from "./global-shortcut.ts"
import { MessageShortcut } from "./message-shortcut.ts"

/**
 * All known shortcuts from Slack.
 */
export type SlackShortcut = GlobalShortcut | MessageShortcut

/**
 * Arguments which listeners and middleware receive to process a shortcut from Slack.
 *
 * The type parameter `Shortcut` represents the entire JSON-encoded request body from Slack.
 */
export interface SlackShortcutMiddlewareArgs<
    Shortcut extends SlackShortcut = SlackShortcut,
> {
    payload: Shortcut
    shortcut: Shortcut
    body: Shortcut
    say: SayFn
    respond: RespondFn
    ack: AckFn<void>
}

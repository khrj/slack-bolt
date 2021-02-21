// deno-lint-ignore-file no-explicit-any
import App from "../App.ts"
import { StringIndexed } from "./helpers.ts"
import { AckFn } from "./index.ts"

export interface ReceiverEvent {
    body: StringIndexed
    // TODO: there should maybe be some more help for implementors of Receiver to know what kind of argument the AckFn
    // is expected to deal with.
    ack: AckFn<any>
}

export interface Receiver {
    init(app: App): void
    start(...args: any[]): unknown
    stop(...args: any[]): unknown
}

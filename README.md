<div align="center">
    <img src="assets/logo.svg" width="400" height="400" alt="blueprint illustration">
    <h1>Slack Bolt</h1>
    <p>
        <b>TypeScript framework to build Slack apps in a flash with the latest platform features. Deno port of <a href="https://www.npmjs.com/package/@slack/bolt">@slack/bolt</a></b>
    </p>
    <p>
        <img alt="build status" src="https://img.shields.io/github/workflow/status/KhushrajRathod/slack-bolt/Deno?label=checks" >
        <img alt="language" src="https://img.shields.io/github/languages/top/KhushrajRathod/slack-bolt" >
        <img alt="code size" src="https://img.shields.io/github/languages/code-size/KhushrajRathod/slack-bolt">
        <img alt="issues" src="https://img.shields.io/github/issues/KhushrajRathod/slack-bolt" >
        <img alt="license" src="https://img.shields.io/github/license/KhushrajRathod/slack-bolt">
        <img alt="version" src="https://img.shields.io/github/v/release/KhushrajRathod/slack-bolt">
    </p>
    <p>
        <b><a href="https://deno.land/x/slack_bolt">View on deno.land</a></b>
    </p>
    <br>
    <br>
    <br>
</div>

## Table of Contents

- [Usage](#usage)
- [API](#api)
- [Quirks](#quirks)
- [Supporters](#supporters)
- [Related](#related)

## Usage

```ts
import "https://deno.land/x/dotenv@v2.0.0/load.ts"
import { App } from "https://deno.land/x/slack_bolt@1.0.0/mod.ts"

const app = new App({
    signingSecret: Deno.env.get("SLACK_SIGNING_SECRET"),
    token: Deno.env.get("SLACK_BOT_TOKEN"),
    ignoreSelf: true,
})

app.event("message", async ({ event, say }) => {
    console.log(event)
    await say("pong")
})

await app.start({ port: 3000 })
console.log("🦕 ⚡️")
```

## API

- Methods are similar to the [node @slack/bolt](https://www.npmjs.com/package/@slack/bolt)
- Full generated documentation is available [here](https://doc.deno.land/https/deno.land/x/slack_bolt@1.0.0/mod.ts)

## Quirks

`OpineReciever` and `HTTPReceiver`/`SocketModeReciever` req/res types are not compatible. This causes trouble when providing a custom callback for built-in oauth failure / success (if you're not using built-in oauth / not implementing custom callbacks for failure / success, you don't have to worry about this). This requires a [type guard](https://www.typescriptlang.org/docs/handbook/advanced-types.html) (See simpler alternative below).

```ts
import { ServerRequest } from "https://deno.land/std@0.87.0/http/server.ts"
import {
    ParamsDictionary,
    Request as OpineRequest,
    Response as OpineResponse,
} from "https://deno.land/x/opine@1.1.0/mod.ts"

const customCallbackOptions = {
    failure: async (
        req: ServerRequest | OpineRequest<ParamsDictionary, any, any>,
        res?: OpineResponse<any>,
    ) => {
        if (isOpineRequest(req)) {
            // Your custom code here, req is Request<ParamsDictionary, any, any> and res is Response<any> from deno.land/x/opine
            // Example:
            res?.setStatus(500).send(
                "<html><body><h1>OAuth failed!</h1><div>See stderr for errors.</div></body></html>",
            )
        } else {
            // Your custom code here, req is a std/http ServerRequest, res is undefined
            // Example:
            await req.respond({
                status: 500,
                headers: new Headers({
                    "Content-Type": "text/html",
                }),
                body:
                    `<html><body><h1>OAuth failed!</h1><div></div></body></html>`,
            })
        }

        function isOpineRequest(
            _req: ServerRequest | OpineRequest<ParamsDictionary, any, any>,
            res?: OpineResponse<any>,
        ): _req is OpineRequest<ParamsDictionary, any, any> {
            return !!res // If res exists, OpineReciever is being used since only 'req' exists for HTTPReciever and SocketModeReceiver
        }
    },
}
```

Alternatively, just specify the correct type according to your Receiver (if you don't specify this, its `HTTPReceiver` by default)

- For HTTPReceiver (default) / SocketModeReceiver

```ts
import { ServerRequest } from "https://deno.land/std@0.87.0/http/server.ts"
const customCallbackOptions = {
    failure: async (req: ServerRequest) => {
        // Your custom code here
        // Example:
        await req.respond({
            status: 500,
            headers: new Headers({
                "Content-Type": "text/html",
            }),
            body: `<html><body><h1>OAuth failed!</h1><div></div></body></html>`,
        })
    },
}
```

- For OpineReceiver

```ts
import {
    ParamsDictionary,
    Request as OpineRequest,
    Response as OpineResponse,
} from "https://deno.land/x/opine@1.1.0/mod.ts"

const customCallbackOptions = {
    failure: async (
        req: OpineRequest<ParamsDictionary, any, any>,
        res: OpineResponse<any>,
    ) => {
        // Your custom code here, req is Request<ParamsDictionary, any, any> and res is Response<any> from deno.land/x/opine
        // Example:
        res?.setStatus(500).send(
            "<html><body><h1>OAuth failed!</h1><div>See stderr for errors.</div></body></html>",
        )
    },
}
```

## Supporters

[![Stargazers repo roster for @KhushrajRathod/slack-bolt](https://reporoster.com/stars/KhushrajRathod/slack-bolt)](https://github.com/KhushrajRathod/slack-bolt/stargazers)

[![Forkers repo roster for @KhushrajRathod/slack-bolt](https://reporoster.com/forks/KhushrajRathod/slack-bolt)](https://github.com/KhushrajRathod/slack-bolt/network/members)

## Related

- [Deno Slack SDK](https://github.com/slack-deno/deno-slack-sdk)
- [Deno modules](https://github.com/KhushrajRathod/DenoModules)

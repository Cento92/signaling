# C92 Signaling

`signaling` is the current peer-to-peer WebRTC signaling prototype for Relay
Center calls. An operator starts a call, the service emails a short-lived
invitation, and the invited user joins through a minimal browser client.

The repository contains:

- a Go HTTP and WebSocket signaling server;
- the standalone operator UI at `/op/`;
- an embeddable operator JavaScript module for `rc-ui`;
- the invited-user UI at `/user/`;
- shared WebRTC, signaling, call-view, and CSS modules.

This version relays signaling messages only. Browser media remains peer to
peer; the server does not terminate, record, or inspect RTP.

## Call flow

```text
rc-ui OperatorCall
    |
    | GET /bootstrap (Accept: application/json)
    | dynamic import /op/app.js
    | WebSocket /ws as role=operator
    v
C92 signaling ---- Resend email ----> invited user
    ^                                      |
    |                                      | GET /client#<challenge>
    |                                      | WebSocket /ws as role=user
    +----------- WebRTC signaling ---------+

Operator browser <======= WebRTC media =======> User browser
```

The invitation challenge is random, stored by the server only as a SHA-256
digest, expires after five minutes, and is removed after the first successful
or failed redemption attempt. It is placed in the URL fragment so it is not
sent in the initial HTTP request.

## Requirements

- Go 1.27 or the version declared in `go.mod`;
- a Resend API key and verified sender for email invitations;
- a browser with WebRTC and camera/microphone support;
- HTTPS in deployed environments (`localhost` is the browser exception);
- a reverse proxy that supports WebSocket upgrades when deployed behind one.

Phone recipients are recognized by the protocol but phone delivery is not
implemented. Use an email address for end-to-end testing.

## Configuration

The service loads `.env.local` from its working directory at startup using
`godotenv`. The file is gitignored. Variables already supplied by the process
or container take precedence.

Create `.env.local`:

```dotenv
SIGNALING_ADDR=:9090
OPERATOR_URL=https://sig.cento92.com/op
CLIENT_URL=https://sig.cento92.com/client
OPERATOR_EMBED_ORIGINS=https://rc-dev.cento92.com,https://apex.cento92.com
DELIVERY_FROM=relay-center@cento92.com
RESEND_API_KEY=<your-resend-api-key>
```

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SIGNALING_ADDR` | no | `:9090` | HTTP and WebSocket listen address |
| `OPERATOR_URL` | no | `https://sig.cento92.com/op` | Direct bootstrap redirect target |
| `CLIENT_URL` | no | `https://sig.cento92.com/client` | Base URL placed in invitation emails |
| `OPERATOR_EMBED_ORIGINS` | no | Apex production and RC development origins | Comma-separated CORS and WebSocket origin allowlist |
| `DELIVERY_FROM` | no | `relay-center@cento92.com` | Resend sender address |
| `RESEND_API_KEY` | yes for email | none | Resend API credential |

Do not commit `.env.local` or place credentials in Go or browser source. For a
container deployment, inject these variables through the container environment
or mount `.env.local` into the process working directory.

## Run locally

From the repository root:

```bash
go mod download
go run .
```

The server listens on `http://localhost:9090` by default.

- Standalone operator: <http://localhost:9090/op/>
- Invited user: <http://localhost:9090/user/>
- WebSocket endpoint: `ws://localhost:9090/ws`

Run the process from the repository root because static files are served from
`./web`.

For a fully local invitation flow, set both public URLs to localhost:

```dotenv
OPERATOR_URL=http://localhost:9090/op
CLIENT_URL=http://localhost:9090/client
OPERATOR_EMBED_ORIGINS=http://localhost:5173
```

Open the operator and invitation in separate browser profiles. Localhost is
treated as a secure context by modern browsers; a LAN IP over plain HTTP is
not, so media capture will normally fail from another device without HTTPS.

## Embed the operator UI

`GET /bootstrap` returns an embedding configuration when the request accepts
JSON:

```bash
curl -i \
  -H 'Accept: application/json' \
  -H 'Origin: https://rc-dev.cento92.com' \
  https://sig.cento92.com/bootstrap
```

Example response:

```json
{
  "module_url": "https://sig.cento92.com/op/app.js",
  "stylesheet_url": "https://sig.cento92.com/shared/app.css",
  "signaling_url": "wss://sig.cento92.com/ws"
}
```

The host application dynamically imports the module and mounts it:

```js
const response = await fetch("https://sig.cento92.com/bootstrap", {
  headers: { Accept: "application/json" }
});
const config = await response.json();
const operator = await import(config.module_url);

const unmount = operator.mountOperatorCall(shadowRoot, {
  signalingUrl: config.signaling_url,
  stylesheetUrl: config.stylesheet_url,
  embedded: true
});

// Close the socket, peer connection, media tracks, and audio meters.
unmount();
```

Mounting inside a Shadow DOM is recommended because the operator stylesheet is
designed as a complete UI rather than as part of the host application's design
system. The `rc-ui` payload page follows this pattern in `OperatorCall.svelte`.

Requests from an origin not listed in `OPERATOR_EMBED_ORIGINS` receive `403`.
The allowlist controls both HTTP assets and the WebSocket `Origin` check.

## Bootstrap behavior

`/bootstrap` supports `GET` and `POST`:

- requests with `Accept: application/json` receive module, stylesheet, and
  WebSocket URLs;
- normal browser navigation receives a `302` redirect to `OPERATOR_URL`;
- a second operator receives `409 Conflict`;
- a request whose TCP peer is not private, loopback, or link-local receives
  `404 Not Found`.

The private-source check uses `RemoteAddr`, not `X-Forwarded-For`. Behind a
reverse proxy, verify that this matches the intended trust boundary. Origin
checking is not a substitute for Apex/Keycloak authorization: this prototype
does not validate an Apex identity or access token.

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /bootstrap` | Operator capacity check, redirect, or embedding configuration |
| `GET /client` | Notify the operator and redirect the invitee to `/user/` |
| `GET /op/` | Standalone operator application |
| `GET /user/` | Invited-user application |
| `/shared/*` | Shared JavaScript and CSS assets |
| `GET /ws` | Operator/user WebSocket signaling |

## WebSocket protocol

Every connection must begin with:

```json
{
  "type": "connect",
  "payload": {
    "id": "non-empty-client-id",
    "role": "operator"
  }
}
```

Allowed roles are `operator` and `user`. The current server has one in-memory
room with capacity for one operator and one active user.

The operator creates an invitation with `join.offer`:

```json
{
  "type": "join.offer",
  "payload": {
    "client_email": "person@example.com",
    "media": { "audio": true, "video": true }
  }
}
```

The user redeems the fragment challenge with another `join.offer`:

```json
{
  "type": "join.offer",
  "payload": {
    "solved_challenge": "opaque-fragment-value"
  }
}
```

After verification, both sides receive `peer-ready`. The server then forwards
the following message types between the verified peers:

- `video-offer`
- `video-answer`
- `candidate`
- `media.status`
- `peer-retry`
- `peer-retry-request`

Lifecycle and delivery results use `offer.status` with a state string and an
HTTP-style status code.

## Test

```bash
go test ./...
```

The suite covers invitation delivery, successful and failed challenge
validation, media selection, operator capacity, signaling gates, bootstrap
responses, and embedded-origin enforcement. Some tests open local loopback
HTTP and WebSocket listeners.

## Deployment checklist

1. Provision `RESEND_API_KEY` outside Git and rotate any credential that was
   previously committed.
2. Deploy signaling before deploying an `rc-ui` version that fetches the new
   JSON bootstrap contract.
3. Serve signaling and the invited-user page over HTTPS.
4. Forward WebSocket upgrade headers for `/ws`.
5. Preserve the external `Host` and `X-Forwarded-Proto` values so bootstrap
   returns correct `https` and `wss` URLs.
6. Include every exact RC UI origin in `OPERATOR_EMBED_ORIGINS`.
7. If a Content Security Policy is present in RC UI, allow the signaling
   origin in `script-src` and `style-src`, and its WebSocket origin in
   `connect-src`.
8. Start the binary with `web/` available relative to its working directory.

## Current limitations

- one process-local room;
- one operator and one user at a time;
- no persistence or recovery across restarts;
- no Apex/Keycloak token validation in signaling;
- email invitations only;
- peer-to-peer media rather than server-terminated media;
- no recording, server-side audit trail, or horizontal scaling;
- a new user connection replaces the previous user slot.

See `docs/first-vertical-slice.md` for the planned production architecture.

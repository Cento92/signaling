# First vertical slice developer guide

Status: proposed implementation guide  
Last updated: 2026-08-28

## Purpose

The first vertical slice proves one complete Relay Center call:

1. An authenticated operator creates a call from the RC payload screen.
2. Delivery sends a temporary public invitation link.
3. The user opens a minimal browser client and joins the call.
4. Operator and user exchange audio and video through the C92 RTC service.
5. The service records each participant's audio and video separately.
6. Ending the call produces an auditable recording manifest associated with
   the emergency session.

This is deliberately not a general conferencing system. The supported room
has exactly three logical participants:

- `operator`: an authenticated Relay Center operator;
- `user`: the recipient of a temporary guest invitation;
- `system`: the internal recorder and, later, an optional LLM agent.

The recorder is an internal media sink rather than a browser-controlled peer.
The future LLM uses the same system-participant boundary but must not be part of
the first slice.

## Architectural boundaries

Use the repository structure below:

```text
cmd/signaling/
  main.go

internal/app/
  calls/
  invites/

internal/platform/
  config/
  persistence/
  recording/
  rtc/
  storage/

internal/transport/
  http/
  websocket/

web/
  user/
  shared/
```

Responsibilities are intentionally asymmetric:

- `internal/app` owns call state, authorization decisions, invitations, and
  application-facing interfaces. It must not import HTTP or Pion packages.
- `internal/platform` implements RTC, recording, storage, persistence, and
  configuration. Pion belongs under `internal/platform/rtc`.
- `internal/transport` validates HTTP or WebSocket input, invokes application
  services, and translates their results into protocol responses.
- `cmd/signaling` is only the composition root.
- `web/user` is the small public guest client.
- The operator client is plain JavaScript embedded by RC UI. Svelte owns its
  presentation and emergency workflow; the JavaScript module owns media and
  the peer connection.

Avoid premature interfaces around every Pion type. Keep Pion contained in the
RTC platform package, while keeping call authorization and lifecycle in the
application layer.

## Media topology

Both human peers terminate their WebRTC connection at the RTC service:

```text
User -----------+
                v
            C92 RTC ------ Recorder
                ^              |
Operator -------+              +-- future LLM input
```

Each browser creates one `RTCPeerConnection`. The server forwards incoming RTP
to the other human and tees the same incoming RTP into the recorder.

Because membership is fixed, the server can add the expected outbound tracks
before SDP negotiation:

- the user receives `operator-audio`, `operator-video`, and later
  `system-audio`;
- the operator receives `user-audio`, `user-video`, and later
  `system-audio`.

The first slice supports Opus audio and one explicitly selected video codec.
VP8 is the initial candidate, subject to testing on the actual target mobile
browsers. It does not support screen sharing, simulcast, arbitrary
subscriptions, composite video, or live transcoding.

Pion must provide the WebRTC, ICE, DTLS, SRTP, RTP, and RTCP primitives. C92
code owns the fixed room policy, media forwarding, recording, and audit
semantics. Do not implement cryptographic or wire-protocol primitives locally.

## Trust model

All browser code is untrusted. The public user client is treated as fully
attacker-controlled: a user may rewrite the JavaScript, alter every request,
submit hostile SDP, fabricate identity fields, or call endpoints without using
the UI.

The operator browser is also untrusted, but it has stronger authentication and
authorization through RC UI and Keycloak. Trust is granted by the server to a
specific action, never to a downloaded bundle.

Use separate origins and entry points:

```text
rc.cento92.com
  authenticated operator UI on private Apex ingress

join.cento92.com
  minimal public user UI on public Apex ingress

rtc.cento92.com
  authenticated call negotiation and status API
```

The public bundle must not contain operator functionality. A low-level RTC
module may be shared at build time, but the user and operator must have
separate entry points.

### Server-enforced permissions

| Capability | Operator | User | System |
| --- | --- | --- | --- |
| Publish microphone and camera | yes | yes | internal only |
| Subscribe to the other human | yes | yes | yes |
| Receive system audio | yes | yes | not applicable |
| Create or end a call | RC-authorized | no | internal only |
| Send an invitation | RC-authorized | no | no |
| Read emergency data | RC-authorized | no | least necessary context |
| Access recordings | RC-authorized | no | internal only |
| Select its own role | never | never | never |

Never authorize a participant using a role, call ID, peer name, or track label
sent by the browser. The server derives these values from the authenticated
session or signed credential and rejects conflicts.

An RTC credential should be short-lived and bound to at least:

```json
{
  "aud": "c92-rtc",
  "sub": "participant-session-id",
  "call_id": "call-id",
  "role": "user",
  "publish": ["audio", "video"],
  "subscribe": ["operator", "system"],
  "exp": 0,
  "jti": "unique-token-id"
}
```

The actual expiration is set by the issuer. Join credentials should normally
live for only one or two minutes and should be renewed only for an authorized
reconnection.

## Invitation exchange

The invitation is a temporary capability, not a temporary public port. Apex
has a permanent HTTPS route, while the capability expires and can be revoked.

Prefer a URL fragment so the raw invitation token is not sent in the initial
HTTP request or included in normal proxy path logs:

```text
https://join.cento92.com/#invite=<opaque-token>
```

The user client performs this sequence:

1. Read the token from `location.hash`.
2. Immediately remove it with `history.replaceState`.
3. Hold it in memory only.
4. Wait for an explicit Join action.
5. POST it to the invitation exchange endpoint.
6. Receive a restricted guest session.
7. Request a very short-lived RTC credential using that session.

Do not consume an invitation on a GET request. Email security systems commonly
prefetch links. The invitation must be exchanged by an explicit POST.

Persist only a hash of the invitation token. Bind it to one call and the
`user` role, give it a short expiration, and support explicit revocation. Once
activated, allow bounded reconnection without allowing the token to create a
second participant.

The guest session should use a cookie resembling:

```http
Set-Cookie: __Host-c92-guest=...; Secure; HttpOnly; SameSite=Lax; Path=/
```

The raw invitation and RTC credentials must never be placed in local storage,
analytics, application logs, or signaling logs.

## Public user client hardening

The public page contains only the code required to exchange an invitation,
request camera and microphone access, negotiate the call, display the operator,
and hang up.

It must have:

- no third-party scripts, analytics, or CDN resources;
- no emergency payload or operator personal information;
- no Delivery, Garage, TURN, signing, or server credentials;
- no use of `innerHTML` with signaling or server content;
- no data channels in the first slice;
- no automatic camera or microphone request before the Join action;
- deterministic cleanup of local tracks and its peer connection on exit.

Start with response policies equivalent to:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  connect-src 'self' https://rtc.cento92.com wss://rtc.cento92.com;
  media-src 'self' blob:;
  img-src 'self' data:;
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'none';
  form-action 'self'

Permissions-Policy:
  camera=(self), microphone=(self), geolocation=()

Referrer-Policy:
  no-referrer
```

Adjust the exact directives only when a tested feature requires it.

## Operator embedding in RC UI

The operator RTC implementation may be plain JavaScript. Embed it as a local
ES module imported by a Svelte component, not as a cross-origin iframe.

The module should expose a small lifecycle-oriented API such as:

```js
class OperatorPeer extends EventTarget {
  connect() {}
  setMicrophoneEnabled(enabled) {}
  setCameraEnabled(enabled) {}
  close() {}
}
```

Svelte owns the video elements, controls, state presentation, and navigation.
The module receives the elements and a callback that requests credentials from
an RC server-side remote function. It must never receive a long-lived signing
secret.

Before issuing an operator credential, the RC server must verify all of the
following:

1. The RC session is authenticated.
2. The operator is authorized to manage the emergency.
3. The call belongs to that emergency session.
4. The requested participant role is `operator`.

Unloading the payload component must stop every local media track and close the
peer connection.

## Reduced demo path: static clients and authenticated admission

When the immediate goal is to demonstrate invitation, authorization, and the
operator/user experience, the existing direct operator-to-user media path may
be retained temporarily. This avoids combining a UI rewrite, RC integration,
delivery, authentication, a Pion media router, and recording into one deadline.

This reduced path proves:

- an authenticated operator can create a call;
- Delivery can send a public browser link;
- the public user must present the expected random capability;
- the signaling server admits only the expected `user` and authenticated
  `operator`;
- `peer-ready` is emitted only after both admissions succeed;
- the operator RTC client can be embedded in SvelteKit without depending on
  Svelte.

It does not prove server-side recording or the future system participant. Those
remain required by the complete first vertical slice described elsewhere in
this document.

### Static artifacts

Serve two deliberately different artifacts:

```text
/user/
  index.html                 minimal public user page
  app.js

/sdk/v1/operator-peer.js     framework-neutral ES module
```

The public user page owns its small UI. The operator module owns no application
workflow and should ideally render no controls. RC UI imports it and supplies
video elements, credential callbacks, and operator actions.

For a cross-origin module import, the signaling service must allow the exact RC
origin with CORS and RC's CSP must allow that module and the RTC connection.
Use a versioned module URL so an RTC client change cannot silently alter an
already deployed RC UI. Bundling or copying the pinned module into RC UI is
preferable after the demo because remotely loaded JavaScript executes with the
RC page's privileges.

The module API remains framework-neutral:

```js
const peer = new OperatorPeer({
  localVideo,
  remoteVideo,
  getCredential,
});

await peer.connect();
peer.setMicrophoneEnabled(false);
peer.close();
```

### Public invitation format

Use a non-secret public call reference in the path and the secret capability in
the fragment:

```text
https://join.cento92.com/u/<public-call-reference>#<random-secret>
```

The fragment is not sent to the HTTP server. The public JavaScript must read
it, immediately remove it from the visible URL with `history.replaceState`,
and send it over WSS in the first registration message. The signaling server
hashes and validates the secret against the referenced call before registering
the user.

The public call reference is not an authorization credential. Knowing it must
not reveal call state, participant identity, telephone number, or emergency
data.

An invalid, expired, revoked, or already-conflicting capability must cause the
server to reject and close the WebSocket with an authorization close code. Do
not leave an unauthorized socket connected while merely withholding
`peer-ready`.

For the reduced demo, a valid invitation may reconnect to the single user slot
while the call remains active, replacing a stale connection. A production
follow-up should exchange the invitation for a bounded guest session so a
reloaded page does not repeatedly present the original capability.

### Operator authentication

The operator must be admitted using the existing RC JWT identity, never a
client-supplied `role: operator` value. The target architecture uses the RC
backend-for-frontend and Apex as the authentication boundary:

1. RC validates its existing HTTP-only Keycloak session and the operator's RTC
   permission.
2. RC exchanges that identity for a short-lived, one-use handoff bound to the
   operator and call.
3. Apex consumes the handoff, creates a minimal RTC session on the signaling
   origin, and authenticates the operator WebSocket handshake.
4. Signaling admits the operator only from the identity headers applied by
   Apex.

This flow uses the same authenticated JWT identity without exposing the broad
RC access token to the signaling page or remotely served JavaScript. The
operator UI's former free-form `data` JSON field is not an authentication
mechanism and must not be reintroduced for entering or transporting a JWT.

The authorization contract should use a dedicated permission such as
`rtc:operator`. Reusing `sessions:read:organization` is acceptable only if it
is an explicit product decision; possession of a generic RC account or a
client-supplied role name is not sufficient.

### Apex-authenticated operator ingress

Status: pipeline target; the reduced demo does not implement this admission
flow yet.

A browser WebSocket constructor cannot set an arbitrary `Authorization`
header. Apex can nevertheless apply trusted identity headers because every
WebSocket starts as a normal HTTP Upgrade request. Apex authenticates that
request before its reverse proxy forwards the upgrade to signaling.

```text
RC browser              RC BFF                 Apex                 Signaling
    |                      |                      |                       |
    | start video call     |                      |                       |
    |--------------------->| validate session,   |                       |
    |                      | role, and call      |                       |
    |<-- one-use handoff --|                      |                       |
    |                      |                      |                       |
    | POST /auth/handoff ----------------------->| consume handoff       |
    |<---------------- HttpOnly RTC cookie ------|                       |
    |                      |                      |                       |
    | WSS /ws/operator + RTC cookie ------------>| validate session      |
    |                      |                      | add identity headers  |
    |                      |                      |---- HTTP Upgrade ---->|
    |                      |                      |                       | authorize
    |<======================== WebSocket ===============================>|
```

The detailed contract is:

1. The operator starts the call from RC. RC checks the session already loaded
   into `locals`; if it is absent or expired, RC sends the browser through its
   existing `/login` and `rc-auth` OIDC flow and preserves a safe return target.
   Signaling and Apex must not implement a second RC login flow.
2. RC verifies `rtc:operator` and, when the call belongs to an emergency,
   verifies that the operator may manage that emergency.
3. RC issues or requests a cryptographically signed, one-use handoff with a
   short expiration. The handoff contains only the subject, Core user ID,
   permitted role, call ID, issued-at time, expiration, and unique token ID.
4. The browser submits the handoff in a POST body to the signaling origin. It
   must not appear in a query string, fragment used as a bearer workaround, or
   application log.
5. Apex validates and consumes the handoff, then sets a signaling-origin cookie
   such as `__Host-c92-rtc`. The cookie is `Secure`, `HttpOnly`, has `Path=/`,
   uses `SameSite=Lax`, has no `Domain` attribute, and has a short lifetime
   bounded by the call. The cookie carries a minimal RTC session, never the RC
   access or refresh token.
6. Apex requires that session for the operator page and for
   `/ws/operator`. It validates the session again on every WebSocket handshake.
   Normal HTTP requests without a session return to the RC entry route. An
   unauthorized or expired WebSocket handshake returns `401` before upgrade;
   because browsers expose little handshake detail to JavaScript, the operator
   page should navigate back to the RC entry route after this failure.
7. Apex removes every client-supplied authentication header and applies the
   verified identity to the upstream Upgrade request. A minimal initial header
   contract is:

   ```http
   X-C92-Subject: <Keycloak subject>
   X-C92-User-ID: <Core user ID>
   X-C92-Roles: rtc:operator
   X-C92-Call-ID: <call ID>
   ```

8. Signaling reads those headers and authorizes the operator before calling
   `Upgrade`. The first WebSocket message may describe the client, but its
   `id` or `role` fields never grant authority.

The operator and guest WebSocket paths should be separate:

- `/ws/operator` requires the Apex RTC session and trusted operator headers;
- `/ws/user` uses the public invitation capability and does not receive
  operator identity headers.

Apex must overwrite, rather than append to, all trusted headers. It must not
forward the RC bearer token to signaling. `X-Ingress: private` is useful route
evidence but is not user authentication. Signaling must also be unreachable
around Apex: for the single-host deployment it should listen on
`127.0.0.1:9090`, while a distributed deployment needs an equivalent private
network or mutually authenticated service boundary.

Pipeline implementation slices:

1. define the `rtc:operator` permission and the handoff/session claim schema;
2. add safe return-after-login behavior and the authenticated handoff action
   to RC;
3. add the RTC handoff/session middleware and trusted-header rewrite to Apex;
4. split operator and guest WebSocket endpoints;
5. make signaling authorize Apex identity before upgrading the operator
   connection and stop trusting the registration role;
6. test anonymous access, header spoofing, wrong roles, wrong call binding,
   expiration, handoff replay, session expiry, and the valid end-to-end path.

### Admission and `peer-ready`

The signaling sequence is:

```text
Operator / RC             Apex              Signaling              User
   | authenticated handoff  |                    |                    |
   |----------------------->|                    |                    |
   | WSS + RTC session      |                    |                    |
   |----------------------->| trusted identity   |                    |
   |                        |------------------->|                    |
   |                        |                    |<-- WSS register ---|
   |                        |                    | call ref + secret  |
   |                        |                    | validate invitation|
   |<-------------------------- peer-ready ------|---- peer-ready --->|
   | create and send offer  |                    |                    |
```

Only the server decides when both required roles are present. A client ID and
role in the registration message are descriptive at most and must not grant
authority. Validation must happen before inserting the connection into the
room registry.

The reduced demo has a hard capacity of one operator. A private bootstrap
request made while that slot is occupied returns `409 Conflict` with a clear
capacity message. WebSocket registration remains the authoritative admission
check: a second operator that bypasses bootstrap or races the first receives an
`offer.status` with state `operator-capacity-reached` and HTTP status `409`,
then the server closes that socket with WebSocket code `1013` (Try Again
Later). The existing operator is never replaced or disconnected by the
rejected attempt.

### Simple call creation endpoint

A simple operator action is appropriate, but do not place the phone number in
the URL path. Paths are routinely retained by proxies, access logs, browser
history, and monitoring systems.

Use an authenticated POST instead:

```http
POST /api/v1/call
Authorization: Bearer <operator credential>
Content-Type: application/json

{
  "phone_number": "+39...",
  "external_ref": "<emergency-session-id>"
}
```

The application service then:

1. validates the operator and emergency-management authorization;
2. generates a call ID, public call reference, and random invitation secret;
3. stores only the secret hash and its expiration;
4. asks Delivery to send the public URL;
5. returns the call ID, operator RTC credential, and delivery status;
6. allows RC to show a Copy Link fallback without exposing it in server logs.

`POST /api/v1/call` may be a small demo facade over the more resource-oriented
call and invitation operations. It should not make Delivery or the phone number
part of the RTC room model.

### Minimal user UI

The public page should initially show only:

- a clear call invitation and recording/permission notice;
- one primary Join button;
- remote operator video;
- a small muted local preview;
- microphone, camera, and Hang Up controls;
- one concise connection/error status.

Do not show peer IDs, SDP, ICE events, diagnostic logs, emergency identifiers,
or event dumps in the user interface. Diagnostics remain in opt-in development
logging and must not contain credentials.

## RTC service hardening

Treat SDP, ICE candidates, RTP, RTCP, and all client state as hostile input.
The server must:

- limit request and SDP sizes;
- allow only configured codecs and media directions;
- allow at most one audio and one video publisher per human role;
- reject unexpected data channels;
- enforce bitrate, call-duration, and connection limits;
- rate-limit invitation exchange and negotiation;
- apply ICE, peer, and idle timeouts;
- reject ICE destinations that target loopback, link-local, metadata, or
  protected internal networks;
- bound media queues and define their overflow behavior;
- use NACK, PLI, and sender/receiver reports from Pion interceptors;
- return generic authorization failures that do not reveal call existence;
- derive canonical participant state and timestamps from server observations.

Client-generated status and timestamps are advisory. Audit events such as
`participant.joined`, `recording.started`, and `call.ended` must be generated by
the server.

Signaling and the public page travel through Apex over HTTPS. Media uses
DTLS-SRTP over ICE and cannot travel through Apex's HTTP reverse proxy. Use one
fixed UDP port with Pion ICE UDP mux, plus short-lived TURN credentials for
fallback. Do not create per-call public ports or dynamic Apex routes.

## Minimal first-slice API

The exact paths may evolve, but the first slice needs these operations:

```text
POST /api/v1/calls
POST /api/v1/calls/{call_id}/invites
POST /api/v1/invitations/exchange
POST /api/v1/calls/{call_id}/join
POST /api/v1/calls/{call_id}/peers/{role}/offer
POST /api/v1/calls/{call_id}/end
GET  /api/v1/calls/{call_id}
```

The initial negotiation may use non-trickle ICE: gather candidates in the
browser, submit one complete offer over HTTP, and return one answer. This is
acceptable for the first slice and removes WebSocket signaling complexity.
Call-state updates may initially use polling; WebSocket or SSE status can be
added without changing the media contract.

## Recording contract

Recording is performed from incoming server-side media, never from either
browser. Store the encoded human tracks separately:

```text
calls/<call-id>/user/audio.ogg
calls/<call-id>/user/video.ivf
calls/<call-id>/operator/audio.ogg
calls/<call-id>/operator/video.ivf
calls/<call-id>/manifest.json
```

For the first slice, files may be finalized and uploaded to Garage when the
call ends. The manifest contains:

- call ID and external emergency session reference;
- participant role and track kind;
- codec and clock rate;
- server-observed start and end timestamps;
- byte size and SHA-256 digest;
- Garage object key;
- recording completion or failure state.

Raw recordings are immutable. Later postprocessing creates versioned derived
artifacts rather than replacing raw media. Rolling crash-resistant segments,
container conversion, transcription, LLM interaction, and detailed auditing
are follow-up slices.

The service must verify that the recording spool is writable before admitting
participants. A recording failure during an active emergency call is surfaced
and audited but must not automatically disconnect the humans.

## First vertical slice implementation order

1. Restructure the Go service into `app`, `platform`, and `transport` without
   changing the working browser proof of concept.
2. Add call IDs, the fixed participant roles, invitation state, and
   configuration. Replace the global room with a room registry keyed by call
   ID.
3. Terminate operator and user PeerConnections in Pion and forward their audio
   and video through the server.
4. Tee incoming tracks into four server-side recording files and produce the
   manifest on hangup.
5. Prove the complete media and recording path locally in two real browsers.
6. Add the public guest invitation exchange and hardened user page.
7. Embed the plain JavaScript operator client in an RC payload component.
8. Upload recordings and the manifest to Garage and associate the call ID with
   the emergency session.
9. Add the static Apex public route, fixed UDP media port, and TURN fallback.
10. Ask Delivery to send the capability URL, while retaining a Copy Link
    fallback for demonstrations and provider failures.

## Acceptance criteria

The slice is complete only when all of the following are demonstrated:

- An authenticated operator creates a call from an emergency payload.
- Delivery sends, or the operator copies, a temporary public invitation.
- An expired or revoked invitation cannot be exchanged.
- The user cannot select or obtain the operator role by changing client code.
- The user page receives no emergency payload or privileged API capability.
- Operator and user exchange two-way audio and video through the RTC service.
- Each browser publishes no more than one audio and one video track.
- The server records four distinct tracks and creates a complete manifest.
- The manifest is associated with the correct emergency session.
- Leaving the page stops camera and microphone tracks.
- Server audit events reflect observed joins, departures, recording state, and
  call termination.
- The flow works from a real phone on mobile data, including TURN fallback.
- Failure of Delivery has a Copy Link fallback.

## Explicitly out of scope

Do not add these to the first vertical slice:

- multi-user or durable chat;
- LLM transcription, decisions, or synthesized speech;
- native application download;
- multi-node room distribution;
- arbitrary participant counts;
- screen sharing or simulcast;
- composite recordings or live transcoding;
- dynamic public ports or Apex routes;
- generalized workflow or plugin systems.

The first follow-up slice should connect an audio consumer to the existing
`system` boundary, record its inputs and outputs, and only then allow it to
publish a clearly identified `system-audio` track.

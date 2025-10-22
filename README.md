# Cloudflare Ayame-DO Signaling Service

This project hosts a Cloudflare Workers + Durable Objects implementation of the Ayame-compatible "Ayame-DO" signaling server. It routes every WebSocket client to a room-specific Durable Object, pairs at most two peers per room, relays SDP/ICE/application messages, and integrates optional webhooks for authentication and disconnect notifications.

The implementation targets Cloudflare's edge runtime and follows the refactored Ayame-DO specification included with this repository. This document outlines how to run the worker, how the protocol behaves, and where the current code diverges from the spec.

## Architecture Overview
- **Worker entrypoint (`src/index.ts`)** handles HTTP requests, exposes the health endpoint, and resolves `/signaling` upgrades to the correct room Durable Object using `env.ROOMS_DO.idFromName(roomId)`.
- **`RoomDurableObject`** manages exactly one logical room. It accepts the WebSocket upgrade, enforces the Ayame-style protocol, performs optional webhook calls, manages heartbeats/timeouts, and relays signaling messages between the two participants.
- **Durable Object bindings** are declared in `wrangler.toml`. The worker looks for `ROOMS_DO` first and falls back to the legacy `SIGNALLING_ROOM` name for backwards compatibility.

## Getting Started

### Prerequisites
- Node.js 18+ (Workers uses an ES2022 runtime and ESM modules).
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) 3.x (installed via `npm install`).
- A Cloudflare account with the Workers and Durable Objects features enabled.

### Install Dependencies
```bash
npm install
```

### Local Development
```bash
npm run dev
```
This runs `wrangler dev`, standing up a local Workers runtime and Durable Object stub. Requests to `/.ok` should return HTTP 200; WebSocket upgrades to `/signaling?roomId=demo` will be routed to the in-memory DO instance.

### Deployment
```bash
npm run deploy
```
`wrangler deploy` publishes the worker and registers Durable Object migrations defined in `wrangler.toml` (`v1` for the legacy `SignallingRoom`, `v2` for `RoomDurableObject`). Ensure that the `ROOMS_DO` binding points at your Durable Object namespace before deploying.

## Configuration

All runtime knobs are provided through Worker environment variables. Defaults mirror the spec.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `AUTHN_WEBHOOK_URL` | string | unset | Optional POST URL invoked during registration. Must return `{ allowed: boolean, ... }`.
| `DISCONNECT_WEBHOOK_URL` | string | unset | Optional POST URL invoked whenever a WebSocket closes.
| `COPY_WEBSOCKET_HEADER_NAMES` | string | unset | Comma-separated list of header names to forward to both webhooks.
| `TYPE_MESSAGE` | boolean | `false` | Enables relaying `{ "type": "message" }` frames between peers.
| `WS_PING_INTERVAL_SEC` | number | `5` | Interval (seconds) between server-initiated `{ "type": "ping" }` frames in normal mode.
| `WS_PONG_TIMEOUT_SEC` | number | `60` | Timeout (seconds) to await `{ "type": "pong" }` after a ping before closing the connection.
| `WS_READ_TIMEOUT_SEC` | number | `90` | Maximum idle time (seconds) without receiving any frame before closing the socket.
| `READ_LIMIT_BYTES` | number | `1048576` | Maximum size in bytes for any inbound WebSocket message.

Durable Object binding (wrangler snippet):

```toml
[durable_objects]
bindings = [
  { name = "ROOMS_DO", class_name = "RoomDurableObject" }
]
```

## HTTP Surface

| Method & Path | Description |
| --- | --- |
| `GET /.ok` | Liveness probe. Returns `200` with an empty body.
| `GET /signaling` | Upgrades to WebSocket. Requires a `roomId` in the query string (`?roomId=...`) or `CF-Room-Id` header so the Worker can route to the correct Durable Object. Missing identifiers result in HTTP 400; mismatches are rejected by the DO with close code `1008` during registration.

## WebSocket Protocol

### Registration (`type: "register"`)
The first frame on every new socket must be a JSON message:

```json
{
  "type": "register",
  "roomId": "example-room",
  "clientId": "optional",
  "signalingKey": "optional",
  "key": "legacy-alias",
  "authnMetadata": {"any": "json"},
  "ayameClient": "sdk/1.0.0",
  "libwebrtc": "m97",
  "environment": "browser",
  "standalone": false
}
```

Rules enforced by `RoomDurableObject`:
- `roomId` must match the identifier in the upgrade request; mismatches close the socket with status `1008`.
- Only two registrations succeed per room. The third receives `{ "type": "reject", "reason": "full" }` followed by a normal close (`1000`).
- If `AUTHN_WEBHOOK_URL` is set, the server POSTs the registration payload to it. Only `200` responses with `{ allowed: true }` admit the client. On success, `iceServers` and `authzMetadata` from the webhook are mirrored in the `accept` message.

Successful registration yields:

```json
{
  "type": "accept",
  "connectionId": "01JABCDEFGHJKLMNPQRSTUVWX",
  "isExistClient": false,
  "isExistUser": false,
  "authzMetadata": {"role": "guest"},
  "iceServers": [
    {"urls": ["stun:stun.example.net"], "username": "optional", "credential": "optional"}
  ]
}
```

On failure the client receives `{ "type": "reject", "reason": "<string>" }` before the socket closes.

### Post-registration Messaging

After registration the DO relays specific message types verbatim between peers:

| Type | Direction | Notes |
| --- | --- | --- |
| `offer` | client → server → peer | SDP offer forwarding.
| `answer` | client → server → peer | SDP answer forwarding.
| `candidate` | client → server → peer | ICE candidate forwarding.
| `message` | client → server → peer | Forwarded only when `TYPE_MESSAGE=true`; otherwise treated as protocol error.

Control messages handled by the server:

| Type | Direction | Purpose |
| --- | --- | --- |
| `ping` | server → client | Heartbeat emitted on the configured interval (disabled when `standalone=true`).
| `pong` | client → server | Must be sent in response to each `ping`. Missing pongs trigger a close after `WS_PONG_TIMEOUT_SEC`.
| `connected` | client → server | Optional application signal. In standalone mode the server treats this as a cue to close the socket with code `1000`.
| `bye` | server → client | Sent to the surviving peer when the other side disconnects in normal mode, followed by the server closing both sockets.

Any other message type results in a protocol error and a `1000` close.

### Heartbeats & Timeouts
- **Ping interval** defaults to 5 seconds (`WS_PING_INTERVAL_SEC`).
- **Pong watchdog** closes the socket if no `{ "type": "pong" }` arrives within `WS_PONG_TIMEOUT_SEC` seconds.
- **Read deadline** closes the connection if no frame is received within `WS_READ_TIMEOUT_SEC` seconds, regardless of ping/pong activity.
- **Read limit** rejects frames larger than `READ_LIMIT_BYTES` (default 1 MiB) based on their UTF-8 byte length.

### Standalone Mode
Clients that set `"standalone": true` in the registration message receive special treatment:
- The server skips heartbeat pings and pong timeouts.
- `bye` is not sent to the peer when the standalone client disconnects.
- Receiving `{ "type": "connected" }` causes the server to close the standalone socket immediately.

### Webhooks

**Authentication webhook** (`AUTHN_WEBHOOK_URL`):
- Invoked before admitting a registrant.
- Request JSON includes `roomId`, `clientId`, generated `connectionId`, `signalingKey`/`key`, and metadata fields (`authnMetadata`, `ayameClient`, `libwebrtc`, `environment`).
- Headers listed in `COPY_WEBSOCKET_HEADER_NAMES` are forwarded when present on the upgrade request.
- Must return `200` with `{ allowed: true }` to accept the client. Optional `iceServers` and `authzMetadata` properties are echoed back in the `accept` payload.

**Disconnect webhook** (`DISCONNECT_WEBHOOK_URL`):
- Fired whenever a socket closes (both successful and rejected registrations).
- Receives `{ roomId, clientId, connectionId }` plus any copied headers.
- Errors are logged but do not affect teardown.

## Durable Object Lifecycle
1. Worker resolves the `roomId` provided in the WebSocket upgrade to a Durable Object instance via `env.ROOMS_DO.idFromName(roomId)`.
2. The DO accepts the WebSocket, enforces that the first message is a valid registration, optionally calls the auth webhook, and assigns the participant to slot `a` or `b`.
3. When both slots are populated, the DO relays signaling frames between the two sockets.
4. Disconnects, timeouts, or protocol errors trigger teardown: optional `bye`, webhook notifications, closing both sockets with code `1000`, and clearing the room state so new participants can join.

## Known Gaps / Spec Divergences

No known deviations from the Ayame-DO spec at this time. If you spot something unexpected, please file an issue so we can track it.

## Next Steps
- Add automated protocol tests (for example using Miniflare) to cover registration success/denial, heartbeat, webhook, and standalone flows.
- Document operational logging/observability once implemented.

---

With those pieces in place, this repository will provide a Cloudflare-native Ayame-compatible signaling service suitable for WebRTC rendezvous workloads.

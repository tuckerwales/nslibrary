# Device API (HTTP)

The Switch always initiates. The same JSON messages later travel inside USB frames; this document is the HTTP contract (`/api/device/v1`). Schemas live in `packages/shared/src/device-api.ts`. Golden examples: `packages/shared/golden/device-api/`.

A fake Switch for tests and debugging is `packages/device-sim` (`nslib-sim`).

## Pairing

1. The web UI calls `POST /api/v1/devices/pairing-code` (admin session) and shows a 6-digit code. It is valid for 5 minutes and at most 5 tries. Only a SHA-256 of the code is stored.
2. The Switch calls `POST /api/device/v1/pair` with the code and device info. The response token is 32 random bytes, base64url without padding (43 characters). Only its SHA-256 is stored.
3. Later requests send `Authorization: Bearer <token>`. Revoking the device in the web UI returns `DEVICE_REVOKED` until it pairs again.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/pair` | no | Exchange a pairing code for a token |
| `GET` | `/hello` | yes | Server id, protocol version, `catalogRev`, capabilities, optional `appLatest` |
| `PUT` | `/state` | yes | Firmware, AMS, free space, installed-title snapshot |
| `GET` | `/catalog?since&cursor&limit` | yes | Compact catalog. If `since` is the current revision, the body is an empty delta (`full: false`). Otherwise a paginated full listing (`full: true`) |
| `GET` | `/icons/:appId?v=` | yes | 128px-class JPEG, immutable |
| `GET` | `/files/:fileId` | yes | Range downloads (206), `ETag`, `If-Range`, `If-Match` → `FILE_CHANGED`, missing → `FILE_MISSING` |
| `GET` | `/update` | yes | Latest `nslibrary.nro` when the server has one (LAN fallback; the Switch prefers a signed GitHub Release) |
| `GET` | `/events?cursor&wait=25` | yes | Long-poll. Omitting `cursor` returns queued **and interrupted** jobs plus a catalog event. `wait` is seconds, 0–30 |
| `POST` | `/jobs` | yes | Queue an install started on the Switch |
| `POST` | `/jobs/:id/claim` | yes | Claim a queued or interrupted job for this device |
| `POST` | `/jobs/:id/progress` | yes | ≤1 Hz. Moves the job to `running` |
| `POST` | `/jobs/:id/complete` | yes | `{ok, result?, msg?}` |

Errors are `{error:{code,msg}}` with the same codes over USB.

USB uses the same paths inside `NSLU` frames. The first request is `POST /usb/hello` (device info, no pairing code) unless Settings requires pairing. See [usb-protocol.md](usb-protocol.md).

## Discovery

The Switch broadcasts UDP `NSLIB?1` to port 8466. The server replies unicast with `{serverId,name,port,proto,tls}`. Disable with `NSLIB_DISCOVERY=0`. You can always type an IP by hand.

## Web UI

- **Devices** — pairing code, list, rename, revoke, job status
- **Send to Switch** on a title page — `POST /api/v1/jobs {deviceId, items, target}`
- Settings: prefer NSZ/XCZ when the same title exists in more than one format

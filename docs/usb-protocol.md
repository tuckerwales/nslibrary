# USB protocol (v1)

The Switch is the USB device (libnx `usbComms`, VID `057E` / PID `3000`, one bulk IN and one bulk OUT endpoint). The library host uses libusb through `node-usb` (`packages/usb-host`). The link carries the same requests as the HTTP device API (`/api/device/v1`), so the server handles both transports with one `DeviceApiService`.

Session start: `POST /usb/hello` with the device-info body. The Switch is trusted automatically unless **Require pairing for USB** is on. Ping every 5 s; 15 s of silence or a detach marks running jobs `interrupted`.

In-memory tests: `MemoryDuplex` + `UsbLink` + `UsbDeviceClient` (`packages/device-sim/test/usb-duplex.test.ts`).

Source of truth: `packages/shared/src/usb-frame.ts`. Byte-exact vectors: `packages/shared/golden/usb/frames.json`. The TypeScript tests and the host-native C++ tests under `switch/tests` both check those vectors.

## Frame

Every message is a 32-byte little-endian header, followed by `json_len` bytes of UTF-8 JSON, followed by `payload_len` bytes of binary payload.

| Offset | Size | Field |
|---|---|---|
| 0x00 | 4 | magic `NSLU` |
| 0x04 | 2 | protocol version (`1`) |
| 0x06 | 1 | kind: 1 Request, 2 Response, 3 Cancel, 4 Ping, 5 Pong |
| 0x07 | 1 | flags: bit 0 = payload is a raw stream |
| 0x08 | 4 | request id (echoed in the response) |
| 0x0C | 2 | HTTP-like status (responses only) |
| 0x0E | 2 | reserved, zero |
| 0x10 | 4 | JSON length (at most 1 MiB) |
| 0x14 | 4 | reserved, zero |
| 0x18 | 8 | payload length |

### JSON sections

- **Request:** `{"m":"GET","p":"/files/42","h":{"range":"bytes=0-1048575"},"b":{...}}`. `p` is the path relative to `/api/device/v1`. `b` is the request body.
- **Response:** `{"h":{...},"b":{...}}`. Errors use the same `{"error":{"code","msg"}}` body as HTTP.

## Rules

- **Pairing:** only one request is in flight at a time. The Switch sends a Request, and the host replies with exactly one Response carrying the same request id.
- **Reads:** both sides read exact lengths taken from the header. Payloads are written in chunks of up to 1 MiB. The host sends a zero-length packet when a write ends exactly on a packet boundary.
- **Cancel:** a Cancel frame carrying a request id asks the host to stop streaming that response. The host finishes the current chunk, then sends a final Response with status 499 and no payload.
- **Session start:** the first request must be `POST /usb/hello` with the device info body. A USB-connected device is trusted automatically unless the "require pairing for USB" setting is on.
- **Liveness:** the Switch sends Ping every 5 s and the host answers with Pong. If there is no traffic for 15 s, or the device detaches, the device's running jobs are marked `interrupted`.

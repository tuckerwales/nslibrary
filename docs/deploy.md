# Deploying NSLibrary

The web UI is not a static site. Coolify (or any host) must run the **Node server**, which serves the UI, the API, SQLite, and the library scanner.

## Coolify (Dockerfile)

1. Create a new resource → **Public Repository** (or private with a GitHub App) pointing at this repo.
2. Build pack: **Dockerfile**. Leave the Dockerfile path as `/Dockerfile`.
3. Port: **8465**.
4. Set these environment variables:

   | Name | Value |
   |---|---|
   | `NSLIB_TRUST_PROXY` | `true` |
   | `NSLIB_POLLING` | `true` if your games live on NFS/SMB |
   | `PUID` / `PGID` | UID/GID that should own `/data` (default `1000`) |
   | `NSLIB_SEED` | `true` (default in the image) attaches a synthetic demo library on first boot |
   | `NSLIB_TLS_KEY` / `NSLIB_TLS_CERT` | Optional PEM paths for HTTPS on the Node port (usually leave unset behind Traefik) |
   | `NSLIB_NRO_PATH` | Optional `nslibrary.nro` the Switch can update itself from (**Settings → Check for updates**). Put the release's `update.json` and `update.json.sig` next to it |

   Coolify’s `PORT` is honoured if set; otherwise the app listens on 8465. Prefer the reverse proxy for TLS; in-process HTTPS is for a direct LAN bind.

5. Persistent storage:
   - Destination `/data` — database, keys, icon cache. **Required.**
   - Destination `/library/games` (read-only) — your NSP/NSZ/XCI/NRO dumps. Add more mounts as `/library/<name>` if you want several roots.

6. Enable the HTTP proxy / domain as usual. WebSockets (`/api/v1/ws`) use the same host; Coolify’s Traefik proxies them.

7. After the first deploy, open the URL and create the admin account. A **Demo library** folder is attached automatically (`/library/demo`) so you can browse the UI without real dumps. Add `/library/games` when you mount your own files. Set `NSLIB_SEED=false` to skip the demo.

Do not use Nixpacks/static for this app. The image is `node:22-bookworm-slim` and uses the N-API `better-sqlite3` binary for the container architecture.

## docker compose (Linux host)

From the repo root:

```bash
docker compose up --build
```

Then open `http://localhost:8465`, create an admin account, and browse the demo library. Mount dumps as `/library/<name>:ro` (for example `/library/games`); they are attached as library roots on start.

Multi-arch image (`linux/amd64` and `linux/arm64`):

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t nslibrary .
```

CI runs `docker compose up` and a device-sim smoke (`scripts/docker-smoke.mjs`) against the container.

Locally without Docker: `pnpm seed && NSLIB_SEED=true NSLIB_SEED_DIR="$PWD/data/demo-library" NSLIB_SEED_KEYS="$PWD/data/keys/prod.keys" pnpm start`.

## What is not in this image yet

The Switch `.nro` is built in CI and uploaded as `nslibrary.nro`. Copy it to `sdmc:/switch/nslibrary/`. USB in Docker works only on a Linux host (`/dev/bus/usb` plus `device_cgroup_rules: ["c 189:* rmw"]` and `NSLIB_USB=true`). On Mac or Windows, use the [desktop app](desktop.md) for USB. UDP discovery (`NSLIB?1` on port 8466) works when that port is published, or when the container uses host networking. A Coolify deploy without 8466/udp still serves the library web app and the HTTP device API; enter the server URL on the Switch by hand. See [switch.md](switch.md).

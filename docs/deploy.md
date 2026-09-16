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

   Coolify’s `PORT` is honoured if set; otherwise the app listens on 8465.

5. Persistent storage:
   - Destination `/data` — database, keys, icon cache. **Required.**
   - Destination `/library/games` (read-only) — your NSP/NSZ/XCI/NRO dumps. Add more mounts as `/library/<name>` if you want several roots.

6. Enable the HTTP proxy / domain as usual. WebSockets (`/api/v1/ws`) use the same host; Coolify’s Traefik proxies them.

7. After the first deploy, open the URL, create the admin account, then in **Folders** add `/library/games` (the path *inside* the container).

Do not use Nixpacks/static for this app. Native `better-sqlite3` needs the Docker build.

## docker compose (Linux host)

```bash
docker compose up --build
```

Then open `http://localhost:8465`. Mount your dumps as `/library/games` (read-only) and add that path in **Folders**.

## What is not in this image yet

Switch USB, UDP LAN discovery, and the `.nro` installer are later milestones. A Coolify deploy is the library web app only.

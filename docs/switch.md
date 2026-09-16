# Switch app

The homebrew `.nro` talks to the library over LAN HTTP or a USB cable and streams installs into console storage (SD or NAND) without copying the whole file to the SD card first.

## Host tests (no Switch toolchain)

Needs `libzstd` (headers + library) and CMake. From the repo root:

```bash
pnpm test:switch
```

or `./scripts/build-switch.sh --test`.

These parse `packages/shared/golden/device-api/` and `switch/tests/golden/` (PFS0, HFS0/XCI, NCZ, CNMT, ticket, pipeline).

Rebuild the golden binaries after changing the fixture generator:

```bash
node switch/tests/golden/generate.mjs
```

## Build the `.nro`

You need [devkitPro](https://devkitpro.org/) with `DEVKITPRO` set, plus:

```text
switch-dev switch-cmake switch-pkg-config switch-freetype switch-glfw
switch-mesa switch-libdrm_nouveau switch-curl switch-mbedtls switch-zstd
```

```bash
./scripts/build-switch.sh
```

That inits the Borealis submodule if needed, configures CMake, and writes `switch/build/nslibrary.nro`. Useful flags: `--clean`, `--nxlink`, `--forwarder`, `-j N`. `./scripts/build-switch.sh --help` lists them.

Copy `switch/build/nslibrary.nro` to `sdmc:/switch/nslibrary/nslibrary.nro`.

Each launch writes `sdmc:/config/nslibrary/nslibrary.log` (same folder as `config.json`) and moves the previous run to `nslibrary.prev.log`, so relaunching after a crash keeps the crashed run's log. Lines are flushed as they are written, so the last line is the last thing the app did before a crash. Pull that file off the SD card after a crash. Settings also shows the path.

CI builds the same target in `devkitpro/devkita64` and uploads the artifact.

## Pair and install

1. Start the library server (Docker or `pnpm start`). UDP discovery uses port **8466**.
2. In the web UI, open **Devices** and generate a pairing code.
3. On the Switch, launch NSLibrary. **Look for servers**, or type `http://<host>:8465` (or your HTTPS URL).
4. Enter the 6-digit code.
5. Browse **Library** (icon grid). Open a title for base / update / DLC, then pick **SD card**, **NAND**, or **Auto**.
6. Jobs queued from the web (**Send to Switch**) are picked up by the long-poll. Open **Queue** and press A to cancel.

USB: on the Connect screen choose **USB cable** while NSLibrary is running on the computer (Electron, or Docker on Linux with `/dev/bus/usb`). Windows needs [WinUSB](windows-usb-driver.md).

NSP, NSZ, XCI, and XCZ all install, including **split** dumps (`Title.nsp/00`, `01`, … or `Title.nsp.00`). Homebrew `.nro` files are written to `sdmc:/switch/<name>/`. Hash verification is on by default (Settings).

If a transfer drops, the download resumes from where it stopped with a growing delay (0.5 s up to 8 s). It only gives up after five attempts in a row make no progress, so a long install survives a flaky Wi-Fi link. USB downloads are requested in 64 MB ranges. A USB unplug marks the running job **interrupted**; reconnect (or **Resume** in the web History page) claims it again. NCAs already registered on the console are skipped.

While an install runs, the app keeps posting progress to the server and checking for events, so the web UI shows progress and **Cancel** reaches the console. Over HTTP this uses a second connection; over USB it happens between the 64 MB ranges.

If an install fails, the title being installed is rolled back (placeholders, registered NCAs, and its content-meta entry). Titles in the same file that already finished stay installed. Placeholders are also listed in `sdmc:/config/nslibrary/placeholders.txt`; if the console crashes or loses power mid-install, the next launch deletes them.

Low battery and a firmware requirement newer than the console are shown in the install dialog and on the progress screen.

**HOME menu:** Settings in the web UI can download an NSP forwarder (needs `prod.keys`). Install that NSP and keep `nslibrary.nro` at `sdmc:/switch/nslibrary/nslibrary.nro`.

**Self-update:** Settings → **Check for updates** first asks your library server for a newer signed build (no internet access needed), then checks the latest GitHub Release. Either way the app checks an Ed25519 signature on `update.json`, then the `.nro` SHA-256. See [updates.md](updates.md).

The UI follows the console language (English, Japanese, Chinese, German, French, Spanish, Italian, Portuguese, Russian, Korean, Dutch).

A solid NSZ whose zstd window is larger than about 32 MB will fail in applet mode. Launch NSLibrary while holding R over a game (title override) for those files.

The token is stored at `sdmc:/config/nslibrary/config.json`. For an `https://` server, the first connection records the server's public key there too (`tlsPin`), and later connections refuse a different key. If you replace the certificate with a new key, use **Forget this server** in Settings and connect again. Changing the server address also clears the token and key. Icons cache under `sdmc:/config/nslibrary/icons/`. Revoking the device in the web UI requires pairing again.

## Logs

With the Switch on the same LAN:

```bash
nxlink -s switch/build/nslibrary.nro
```

(`-s` redirects stdout to your terminal.) File logs on the SD card are usually more useful than nxlink after a crash.

## Hardware check (PLAN)

Install a **self-built** test NSP from your library, launch it from the HOME menu, then delete it in System Settings. Repeat with the same title as NSZ and confirm the content IDs match. Cancel an install at 10%, 50%, and 90% and confirm no leftover placeholders and that free space returns.

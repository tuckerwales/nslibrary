# Switch app

The homebrew `.nro` talks to the library over LAN HTTP or a USB cable and streams installs into console storage (SD or NAND) without copying the whole file to the SD card first.

## Host tests (no Switch toolchain)

Needs `libzstd` (headers + library) and CMake. From the repo root:

```bash
pnpm test:switch
```

or:

```bash
cmake -B switch/build-host -S switch
cmake --build switch/build-host --target nslib-switch-tests -j"$(nproc)"
switch/build-host/nslib-switch-tests
```

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
git submodule update --init switch/lib/borealis
cmake -B switch/build -S switch -DPLATFORM_SWITCH=ON
cmake --build switch/build --target nslibrary.nro -j"$(nproc)"
```

Copy `switch/build/nslibrary.nro` to `sdmc:/switch/nslibrary/nslibrary.nro`.

CI builds the same target in `devkitpro/devkita64` and uploads the artifact.

## Pair and install

1. Start the library server (Docker or `pnpm start`). UDP discovery uses port **8466**.
2. In the web UI, open **Devices** and generate a pairing code.
3. On the Switch, launch NSLibrary. **Look for servers**, or type `http://<host>:8465` (or your HTTPS URL).
4. Enter the 6-digit code.
5. Browse **Library** (icon grid). Open a title for base / update / DLC, then pick **SD card**, **NAND**, or **Auto**.
6. Jobs queued from the web (**Send to Switch**) are picked up by the long-poll. Open **Queue** and press A to cancel.

USB: on the Connect screen choose **USB cable** while NSLibrary is running on the computer (Electron, or Docker on Linux with `/dev/bus/usb`). Windows needs [WinUSB](windows-usb-driver.md).

NSP, NSZ, XCI, and XCZ all install. Homebrew `.nro` files are written to `sdmc:/switch/<name>/`. Hash verification is on by default (Settings).

A solid NSZ whose zstd window is larger than about 32 MB will fail in applet mode. Launch NSLibrary while holding R over a game (title override) for those files.

The token is stored at `sdmc:/config/nslibrary/config.json`. Icons cache under `sdmc:/config/nslibrary/icons/`. Revoking the device in the web UI requires pairing again.

## Logs

With the Switch on the same LAN:

```bash
nxlink -s switch/build/nslibrary.nro
```

(`-s` redirects stdout to your terminal.) The app calls `nxlinkStdio()` on launch.

## Hardware check (PLAN)

Install a **self-built** test NSP from your library, launch it from the HOME menu, then delete it in System Settings. Repeat with the same title as NSZ and confirm the content IDs match. Cancel an install at 10%, 50%, and 90% and confirm no leftover placeholders and that free space returns.

# Switch app (M4)

The homebrew `.nro` talks to the library over LAN HTTP. USB, NSZ/XCI, and the 3-thread pipeline are later milestones.

## Host tests (no Switch toolchain)

From the repo root:

```bash
cmake -B switch/build-host -S switch
cmake --build switch/build-host --target nslib-switch-tests -j"$(nproc)"
switch/build-host/nslib-switch-tests
```

These parse `packages/shared/golden/device-api/` and `switch/tests/golden/` (PFS0, CNMT, ticket).

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
5. Browse **Library**, press A, confirm **Install to SD**. Progress is reported to the server (and the web Devices page).
6. Jobs queued from the web (**Send to Switch**) are picked up by the long-poll.

The token is stored at `sdmc:/config/nslibrary/config.json`. Revoking the device in the web UI requires pairing again.

## Logs

With the Switch on the same LAN:

```bash
nxlink -s switch/build/nslibrary.nro
```

(`-s` redirects stdout to your terminal.) The app calls `nxlinkStdio()` on launch.

## Hardware check (PLAN)

Install a **self-built** test NSP from your library, launch it from the HOME menu, then delete it in System Settings.

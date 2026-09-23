# Desktop app (Electron)

The desktop app is the same Node server plus a window and a tray. USB works here on every OS; Docker USB passthrough is Linux-only.

From the repo root (Node ≥ 22.15, pnpm 12):

```bash
pnpm install
pnpm dev:desktop
```

That builds the web UI, then starts Electron. The first desktop start downloads the Electron binary (~100 MB) if pnpm skipped it.

`better-sqlite3` v13 already includes platform binaries; you do not need `node-gyp` or Xcode Command Line Tools for a normal install.

If `pnpm install` still tries to compile SQLite, check `pnpm-workspace.yaml`: `allowBuilds.better-sqlite3` must be `false`.

If Electron prints `failed to install correctly`, from the repo root:

```bash
pnpm rebuild electron
pnpm dev:desktop
```

Node **22 LTS** is the one we test. Node 24 can run the CLI; if something odd shows up, switch with `nvm use 22`.

The “pnpm is running through Node.js…” line is from Corepack skipping pnpm’s own native installer. It is noisy but harmless; `corepack enable` then `corepack prepare pnpm@12.4.2 --activate` installs the binary.

- Data lives in the Electron `userData` directory.
- Closing the window hides it to the tray. **Quit** from the tray menu (or the app menu) stops the server cleanly.
- **Allow LAN devices** binds `0.0.0.0` and turns on UDP discovery. The app offers to restart right away to apply it.
- The server listens on port 8465. If another program has it, the app uses the next free port and remembers it, so paired Switches keep the same address next time.
- To let a Switch update itself from this computer, put `nslibrary.nro`, `update.json`, and `update.json.sig` in `update/` inside the data directory.
- **Pause scanning** stops folder watchers until you turn it off.
- Folders → **Browse…** uses the native directory picker.
- If an admin account already exists, the app sets a local session cookie so you skip sign-in on this machine.

USB: Connect the Switch with a cable and choose **USB cable** on the Connect screen. Windows needs [WinUSB via Zadig](windows-usb-driver.md). Linux: install `packages/electron/udev/99-nslibrary.rules`.

## Packaging

```bash
pnpm --filter @nslib/desktop package:dir  # unpacked app in packages/electron/dist/<platform>-unpacked
pnpm --filter @nslib/desktop dist         # installers: NSIS on Windows, dmg on macOS, AppImage and deb on Linux
```

Both build the web UI, then `scripts/bundle.mjs` bundles the main process into `packages/electron/build/`
with the preload script, migrations, web UI, and forwarder icon, and `electron-builder` packages that.
`pnpm --filter @nslib/desktop start:bundle` runs the bundle without packaging. Build installers on
the platform they're for. The native modules (`better-sqlite3`, `usb`) are N-API with prebuilt
binaries, so there is nothing to compile. The Linux packages include the udev rule under `udev/`.

CI builds all of them on every pull request (downloadable from the run's artifacts for a week), and
each `v*` tag attaches them to the GitHub release, versioned from the tag:

| Platform | File |
|---|---|
| Windows | `NSLibrary-<version>-win-x64.exe` (NSIS installer) |
| macOS | `NSLibrary-<version>-mac-arm64.dmg` (Apple silicon), `NSLibrary-<version>-mac-x64.dmg` (Intel) |
| Linux | `NSLibrary-<version>-linux-x86_64.AppImage`, `NSLibrary-<version>-linux-amd64.deb` |

The installers are **not code-signed**. On macOS, the first launch is blocked: right-click the app
and choose **Open**, or allow it under System Settings → Privacy & Security. On Windows, SmartScreen
asks you to confirm (**More info** → **Run anyway**). Install the `.deb` with
`sudo apt install ./NSLibrary-<version>-linux-amd64.deb` so its dependencies come too. Signing needs
certificates added as repository secrets (`CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder).

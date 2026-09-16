# Desktop app (Electron)

The desktop app is the same Node server plus a window and a tray. USB works here on every OS; Docker USB passthrough is Linux-only.

From the repo root (Node ≥ 22.15, pnpm 12):

```bash
pnpm install
pnpm dev:desktop
```

That builds the web UI, then starts Electron. `better-sqlite3` v13 already includes platform binaries; you do not need `node-gyp` or Xcode Command Line Tools for a normal install.

If `pnpm install` still tries to compile it, check `pnpm-workspace.yaml`: `allowBuilds.better-sqlite3` must be `false`.

The “pnpm is running through Node.js…” line is from Corepack skipping pnpm’s own native installer. It is noisy but harmless; `corepack enable` then `corepack prepare pnpm@12.4.2 --activate` installs the binary.

- Data lives in the Electron `userData` directory.
- Closing the window hides it to the tray. **Quit** from the tray menu.
- **Allow LAN devices** is saved and applied the next time the app starts (binds `0.0.0.0` and UDP discovery).
- **Pause scanning** stops folder watchers until you turn it off.
- Folders → **Browse…** uses the native directory picker.
- If an admin account already exists, the app sets a local session cookie so you skip sign-in on this machine.

USB: Connect the Switch with a cable and choose **USB cable** on the Connect screen. Windows needs [WinUSB via Zadig](windows-usb-driver.md). Linux: install `packages/electron/udev/99-nslibrary.rules`.

Packaging (NSIS, dmg, AppImage/deb) is `electron-builder` in `packages/electron`. The deb should ship the udev rule. Native addons (`better-sqlite3`, `usb`) are rebuilt for Electron at pack time.

# Desktop app (Electron)

The desktop app is the same Node server plus a window and a tray. USB works here on every OS; Docker USB passthrough is Linux-only.

```bash
pnpm --filter @nslib/web build
pnpm --filter @nslib/desktop dev
```

Or `pnpm dev:desktop` from the repo root.

- Data lives in the Electron `userData` directory.
- Closing the window hides it to the tray. **Quit** from the tray menu.
- **Allow LAN devices** is saved and applied the next time the app starts (binds `0.0.0.0` and UDP discovery).
- **Pause scanning** stops folder watchers until you turn it off.
- Folders → **Browse…** uses the native directory picker.
- If an admin account already exists, the app sets a local session cookie so you skip sign-in on this machine.

USB: Connect the Switch with a cable and choose **USB cable** on the Connect screen. Windows needs [WinUSB via Zadig](windows-usb-driver.md). Linux: install `packages/electron/udev/99-nslibrary.rules`.

Packaging (NSIS, dmg, AppImage/deb) is `electron-builder` in `packages/electron`. The deb should ship the udev rule. Native addons (`better-sqlite3`, `usb`) are rebuilt for Electron at pack time.

# Changelog

Notable changes to NSLibrary. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Version numbers below are **Switch app** versions (`switch/CMakeLists.txt`), which is what the
signed self-update checks. The server, web UI, and desktop app ship from the same tag and are
versioned with it from 0.2.0 onward.

Entries before 0.2.0 are reconstructed from commit history; the project was developed privately and
released the `.nro` only.

## [Unreleased]

### Added
- **Manage storage on the Switch.** Select a game, update, or DLC in **Installed** to see how much
  space it uses, then **Uninstall** it or **Move** it between the SD card and system memory.
  Uninstalling a game removes its updates and DLC too and keeps save data; uninstalling an update
  or DLC removes just that and fixes up HOME's record. A move copies first and only deletes the
  original once HOME points at the copy, so cancelling or a failure leaves the title where it was.
- **"Will it fit?" in the web UI.** **Send to Switch** shows what the selected content would take
  from the SD card or system memory, after the installs already queued for that Switch, and asks
  before sending anything that won't fit. **Devices** shows each Switch's free space and what its
  queue will use.
- Web API: `POST /devices/:id/space-check`, and a `device.updated` event when a Switch reports new
  free space or installed titles.
- **NSP → NSZ compression on the server.** The new **Compression** page (and a **Compress** button on
  each NSP in a title's files) compresses titles into an output folder you choose, usually 30 to 60%
  smaller. Program and data NCAs become block-mode NCZ, as nsz writes them, including updates' BKTR
  sections; everything else is copied. Each original NCA must match its CNMT hash as it is read, and
  the finished NSZ is read back and every entry compared with the original before it is kept, so a
  damaged source or a bad write never leaves a file behind. Results show the space saved per file
  and in total. **Compress all** queues every NSP that has no NSZ copy yet. Needs `prod.keys`.
- The Compression page walks through setup (console keys, then where to save NSZ files, choosing
  from folders the server can write to, and creating an `NSZ` folder in your library in one
  click), then shows each compression's step, progress, speed and time left, and what to do next:
  **Delete the NSP** once its NSZ has checked out, or **Try again** after a failure. The nav shows
  how many are running, and a message appears when one finishes, whichever page you're on.
- Settings, behind **Change** once set up: the output folder, how hard to compress (Fast,
  Standard, Smallest), and deleting each NSP automatically once its NSZ checks out (off by
  default).
- `NSLIB_COMPRESS_THREADS` sets how many worker threads compression uses (default: cores − 1, at
  most 4). They are separate from the threads that serve file reads, so installs keep streaming.
- Web API: `GET /compress`, `GET`/`PUT /compress/settings`, `GET /compress/folders`,
  `GET /compress/candidates`, `POST /compress`, `POST /compress/clear`,
  `POST /files/:id/compress`, `/cancel` and `/remove-original`, and `compress.updated` events.

## [0.4.0] - 2026-09-24

### Added
- Sort the library by date added, newest or oldest first, in the web UI (the **Sort** menu next to
  the list and grid buttons) and on the Switch (**Y** on the Library tab). Both remember the choice.
  A game's date is when its first file appeared in the library, so adding an update or DLC later
  does not move it. Libraries scanned before this release have one date for everything they held
  then, so those titles fall back to name order among themselves.
  ([#13](https://github.com/tuckerwales/nslibrary/issues/13))
- `GET /api/v1/apps` accepts `sort=name|added` and `order=asc|desc`, and each title has `addedAt`.
  The device catalog has an optional `a` (date added, epoch seconds).

### Changed
- The Switch library grid is now in name order by default, instead of title ID order.

## [0.3.0] - 2026-09-23

### Added
- **Settings → Account** changes the admin password and signs out every other session.
- `reset-password` sets a new admin password from a shell on the server
  (`node dist/main.js reset-password` in Docker) for when it's forgotten.
- Every library folder is rescanned every 6 hours (`NSLIB_RESCAN_INTERVAL_MIN`, `0` to turn it
  off), so changes a watcher missed on a network mount still show up. The architecture notes already
  described this, but nothing did it.

- The desktop app can be packaged: `pnpm --filter @nslib/desktop package:dir` (or `dist` for installers)
  bundles the main process so it no longer needs `tsx` at runtime.
- Desktop installers for Windows (NSIS), macOS (dmg, Apple silicon and Intel), and Linux (AppImage,
  deb) are built in CI and attached to each GitHub release. They are not code-signed yet.

### Security
- The desktop app, which has no setup token, only accepts creating the admin account from the
  computer it runs on. With **Allow LAN devices** on before setup, anyone on the network could
  otherwise have claimed it.
- Web UI event sockets close when their session ends (sign-out, password change, expiry) instead of
  streaming library events until the page is closed.
- Failed sign-in and pairing attempts from many different addresses no longer accumulate in memory.

### Fixed
- HOME-menu forwarders generated by the Docker image now get the NSLibrary icon. The server looked
  for it at a checkout path that doesn't exist in the image.
- An interrupted install can be dismissed from History. Before, it could only be resumed, and the
  Switch was offered it again on every reconnect.
- Install progress in the web UI no longer lags a step behind when updates arrive in quick
  succession.

## [0.2.0] - 2026-09-19

### Added
- mDNS advertising (`_nslibrary._tcp`), so the server appears in Bonjour and Avahi browsers
  alongside the existing UDP `NSLIB?1` discovery.
- Apache-2.0 licence, `NOTICE`, and `THIRD-PARTY.md` covering Borealis, TweetNaCl, libnx, the
  devkitPro portlibs, and the bundled Archivo font.
- Contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and pull
  request templates, and Dependabot.
- `docs/architecture.md`, replacing the pre-build planning document.

### Changed
- **First-run setup now requires a token.** When `NSLIB_SETUP_TOKEN` is unset, the server generates
  one on boot and prints it to the log, so a server reachable before you have signed up cannot be
  claimed by whoever opens it first. Servers that already have an admin account are unaffected.
- The Docker image runs bundled JavaScript instead of transpiling on every start.

### Removed
- The unused `file.sha256` column.

## [0.1.10]

### Added
- Install clears a title's firmware requirement automatically when the console is older than the
  title asks for.
- Web library shows a grid of cards, matching the Switch app.
- Background file verification with progress and cancellation, streaming NCZ decode.
- Optional `NSLIB_SETUP_TOKEN` for first-run admin creation.
- `Prefer NSZ` honoured in the web UI; USB file ranges are streamed rather than buffered.
- Multi-arch (`linux/amd64`, `linux/arm64`) Docker image published on release tags.

### Fixed
- Stuck installs recover instead of holding the queue.
- Demo keys are kept apart from real `prod.keys`.
- Desktop tray works and its settings take effect.
- titledb is applied on read and no longer leaves gaps.
- The Switch catalog refetches when the library changes mid-paging.
- Pairing, USB sessions, and install history tightened.

## [0.1.9]

### Fixed
- **Reset required version** now resets what DBI's equivalent resets, so HOME stops asking for a
  system update that was removed.

## [0.1.8]

### Added
- **Reset required version** for installed games, on the game and its update.

## [0.1.7]

### Fixed
- Crash when going back after an install: tab rebuilds no longer free the focus Borealis had saved.

## [0.1.6]

### Changed
- Switch UI reworked to be readable at a glance.
- Install results shown on the progress screen.

## [0.1.5]

### Added
- Install results on the progress screen.
- One-step Switch release script (`scripts/release-switch.sh`).

## [0.1.4]

### Fixed
- NCZ patches with thousands of sections are accepted.
- Switch client hardened against malformed server and container data.

## [0.1.3]

### Fixed
- RomFS is released while swapping in a self-update.

## [0.1.2]

### Added
- Self-update from the library server, not only from GitHub Releases.

### Fixed
- Hang at the end of an install.

## [0.1.1]

### Added
- ES tickets.
- Non-blocking connect.
- SD card file log.

### Changed
- Switch installs run on the main thread, after crashes with worker threads.

## [0.1.0]

Initial Switch client: signed GitHub self-update, USB timeouts, install resume, split files, HTTPS,
Switch compare views, and install history.

[Unreleased]: https://github.com/tuckerwales/nslibrary/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tuckerwales/nslibrary/releases/tag/v0.2.0
[0.1.4]: https://github.com/tuckerwales/nslibrary/compare/v0.1.1...v0.1.4
[0.1.1]: https://github.com/tuckerwales/nslibrary/releases/tag/v0.1.1

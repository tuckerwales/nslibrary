# Changelog

Notable changes to NSLibrary. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Version numbers below are **Switch app** versions (`switch/CMakeLists.txt`), which is what the
signed self-update checks. The server, web UI, and desktop app ship from the same tag and are
versioned with it from 0.2.0 onward.

Entries before 0.2.0 are reconstructed from commit history; the project was developed privately and
released the `.nro` only.

## [Unreleased]

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

[Unreleased]: https://github.com/tuckerwales/nslibrary/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/tuckerwales/nslibrary/compare/v0.1.1...v0.1.4
[0.1.1]: https://github.com/tuckerwales/nslibrary/releases/tag/v0.1.1

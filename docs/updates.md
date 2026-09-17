# Switch app updates

The homebrew app can replace itself from your **library server** or from a **signed GitHub Release**. Neither source is trusted on its own: TLS to GitHub is not verified (the Switch CA store is incomplete) and the server could be anyone on the LAN. Authenticity comes from Ed25519.

## Release assets

Each `vX.Y.Z` tag should publish:

| File | Role |
|---|---|
| `nslibrary.nro` | The app |
| `update.json` | `{"version":"X.Y.Z","sha256":"<hex>","size":<bytes>}` with no extra whitespace |
| `update.json.sig` | 64-byte RFC 8032 Ed25519 signature of the **exact** `update.json` bytes |

The public key is compiled into the app (`switch/source/update/verify.cpp`). A release whose JSON does not verify is rejected. After that, the `.nro` must match `sha256` and `size`.

## Publishing

1. Put the 32-byte Ed25519 **seed** (hex) in GitHub Actions secret `NSLIB_UPDATE_SK`. Generate a keypair with:

   ```bash
   node scripts/gen-update-keys.mjs
   ```

   Commit the printed public key in `verify.cpp` if you rotate keys (old apps will not accept new signatures until they are updated once).

2. Bump, test, build, and sign in one step:

   ```bash
   scripts/release-switch.sh patch --key-file path/to/seed.hex   # or minor, major, X.Y.Z
   ```

   The seed can also come from `NSLIB_UPDATE_SK` or `NSLIB_UPDATE_SK_FILE`. This bumps `NSLIB_VERSION` in `switch/CMakeLists.txt`, runs the host tests, builds `nslibrary.nro`, signs it into `dist/`, and checks the signature against the public key in `verify.cpp`. If any step fails, the version bump is undone. `--no-test`, `--clean`, `--out DIR` and `-j N` are available; `--help` lists them.

3. Commit the version bump, then tag and push:

   ```bash
   git tag v0.1.4
   git push origin v0.1.4
   ```

   `.github/workflows/release.yml` builds the `.nro`, signs it with the `NSLIB_UPDATE_SK` repository secret, and creates the GitHub Release. Without that secret, publish the signed files from `dist/` yourself:

   ```bash
   gh release create v0.1.4 dist/nslibrary.nro dist/update.json dist/update.json.sig --verify-tag
   ```

## On the Switch

Settings → **Check for updates**:

1. If the Switch is paired (or on USB), it asks the library server first. This works without internet access.
2. If the server has nothing newer, or no signed app, it checks GitHub.

## Serving the app from the library server

Copy the three release assets into one folder on the server: `data/update/` by default, or the folder of `NSLIB_NRO_PATH`:

```
data/update/nslibrary.nro
data/update/update.json
data/update/update.json.sig
```

The Switch then updates itself through the device API (HTTP or USB):

| Call | Returns |
|---|---|
| `GET /hello` | `caps` includes `update`, and `appLatest` is the version in `update.json` |
| `GET /update/manifest`, `GET /update/signature` | Exact `update.json` and `update.json.sig` bytes |
| `GET /update` | The `.nro` |

The server only advertises `update` when all three files exist and the `.nro` matches the manifest's size and SHA-256, so a half-copied set is not offered. Files are re-read on each `hello`, so replacing them does not need a restart. The Switch still checks the signature itself, refuses a version that is not newer than the running app, and checks the `.nro` SHA-256 before replacing itself. A copy without a valid signature is rejected.

The new `.nro` is written to `sdmc:/switch/nslibrary/nslibrary.nro`. The old file is moved to `nslibrary.nro.old` until the swap finishes, so a crash mid-update never leaves the folder empty (the next launch restores it if needed). Restart from the Homebrew Menu (or the HOME-menu forwarder).

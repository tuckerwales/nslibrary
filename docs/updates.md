# Switch app updates

The homebrew app can replace itself from a **signed GitHub Release**. TLS to GitHub is not trusted (the Switch CA store is incomplete); authenticity comes from Ed25519.

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

2. Bump `NSLIB_VERSION` in `switch/CMakeLists.txt`.

3. Tag and push:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

   `.github/workflows/release.yml` builds the `.nro`, signs it, and creates the GitHub Release.

   Sign locally:

   ```bash
   NSLIB_UPDATE_SK=… node scripts/sign-update.mjs switch/build/nslibrary.nro --out dist --version 0.1.1
   ```

## On the Switch

Settings → **Check GitHub for updates**. The console needs internet access (not only LAN to your library). If GitHub is blocked, the app can offer the `.nro` from your library server (`NSLIB_NRO_PATH` / `data/update/nslibrary.nro`) as a fallback — that path is **not** GitHub-signed.

The new `.nro` is written to `sdmc:/switch/nslibrary/nslibrary.nro`. Restart from the Homebrew Menu (or the HOME-menu forwarder).

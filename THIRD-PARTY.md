# Third-party software

NSLibrary itself is Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). This file lists the
third-party software it links, bundles, or ships alongside, and where each licence lives.

Nothing here is copyleft in a way that affects how you may use NSLibrary. The one weak-copyleft
entry (lightningcss, MPL-2.0) is a build-time tool that is neither modified nor redistributed.

## Switch homebrew (`nslibrary.nro`)

The `.nro` is a linked binary, so these licences travel with every release artifact. `NOTICE` is
published with each release for this reason.

| Component | Licence | Source | How it is used |
|---|---|---|---|
| [borealis](https://github.com/xfangfang/borealis) (xfangfang fork) | Apache-2.0 | `switch/lib/borealis` (submodule, pinned) | UI toolkit; statically linked |
| [TweetNaCl](https://tweetnacl.cr.yp.to/) | Public domain | `switch/source/update/tweetnacl.{c,h}` | Vendored; Ed25519 verification for signed updates |
| [libnx](https://github.com/switchbrew/libnx) | ISC | devkitPro toolchain | Switch system calls, content installation |

Borealis retains its own `LICENSE`, `NOTICE`, and `AUTHORS` inside the submodule. Do not strip them.

### devkitPro portlibs

Linked into the `.nro` via `devkitpro/devkita64`. Each carries its own licence in the toolchain
image; none is modified by this project.

| Portlib | Licence |
|---|---|
| switch-curl | curl (MIT/X derivative) |
| switch-mbedtls | Apache-2.0 |
| switch-zstd | BSD-3-Clause (dual GPL-2.0) |
| switch-freetype | FTL (dual GPL-2.0) |
| switch-harfbuzz | MIT |
| switch-libwebp | BSD-3-Clause |
| switch-libpng | libpng (zlib-style) |
| switch-zlib | zlib |
| switch-glfw | zlib/libpng |
| switch-mesa, switch-libdrm_nouveau | MIT |
| switch-glm | MIT |

## Server, web UI, and desktop

Installed from npm and not redistributed as source. Full resolved list and licence texts:

```bash
pnpm licenses list
```

Principal runtime dependencies:

| Package | Licence |
|---|---|
| fastify, @fastify/{cookie,static,websocket} | MIT |
| better-sqlite3 (SQLite itself is public domain) | MIT |
| drizzle-orm | Apache-2.0 |
| drizzle-kit | MIT |
| zod | MIT |
| chokidar | MIT |
| p-queue | MIT |
| react, react-dom | MIT |
| react-router | MIT |
| @tanstack/react-query | MIT |
| tailwindcss | MIT |
| electron | MIT |
| usb (node-usb) | MIT |

### Bundled font

The web UI ships **Archivo** (`@fontsource-variable/archivo`) under the
[SIL Open Font License 1.1](https://openfontlicense.org/). The font files are copied into the built
assets, so the OFL travels with any deployment that serves the UI. The OFL permits this; it forbids
selling the font on its own and requires that the reserved font name not be used for modified
versions.

### Build-time only

`lightningcss` (MPL-2.0), pulled in by Tailwind/Vite, runs at build time and is not shipped.
`typescript` and `drizzle-orm` are Apache-2.0; everything else in the build path is MIT, ISC,
BSD, or 0BSD.

## Test fixtures

Every fixture in this repository is synthetic.

- `packages/fixtures` builds containers (PFS0, HFS0/XCI, NCA, NCZ) and encrypts them with a
  **generated** keyset. No real key material is present.
- `switch/tests/golden/*` is produced by `switch/tests/golden/generate.mjs` and can be regenerated
  from scratch.
- The demo library created by `pnpm seed` contains no copyrighted content.

No Nintendo code, keys, ROM data, or other copyrighted material is contained in, or distributed
with, this project. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

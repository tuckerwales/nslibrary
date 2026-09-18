# Contributing

Thanks for wanting to help. NSLibrary manages **dumps you made from your own console and your own
cartridges**. Everything below follows from that.

## What this project will not accept

These are hard limits, not preferences. Pull requests and issues that cross them are closed without
discussion.

- **No copyrighted content.** Do not attach, commit, or link NSP/NSZ/XCI/XCZ files, NCA data, ROM
  dumps, icons ripped from retail titles, or anything else you did not create. Test fixtures must be
  synthetic — see `packages/fixtures` and `switch/tests/golden/generate.mjs`.
- **No key material.** Never post `prod.keys`, title keys, header keys, or any fragment of real key
  data, including in a bug report, a log excerpt, or a screenshot. Redact before you paste.
- **No download sources.** NSLibrary does not scrape shops, index title sources, resolve titles to
  downloads, or integrate with anything that does. Patches adding this are out of scope permanently,
  not "not yet".
- **No requests for content.** Issues asking where to obtain games, keys, or firmware will be closed
  and locked.

If you are unsure whether something crosses a line, ask in an issue before writing the code.

## Getting set up

Borealis is a submodule, so clone recursively:

```bash
git clone --recursive https://github.com/tuckerwales/nslibrary.git
cd nslibrary
pnpm install
```

Already cloned? `git submodule update --init --recursive`.

You need Node ≥ 22.15 and [pnpm](https://pnpm.io) 12 (`corepack enable`). Building the `.nro` also
needs [devkitPro](https://devkitpro.org) with `switch-curl` and `switch-libzstd`; the host-native
C++ tests need only `cmake`, `pkg-config`, and `libzstd-dev`.

```bash
pnpm seed          # synthetic demo library, so the UI is usable without real dumps
pnpm dev:server    # API on :8465
pnpm dev:web       # UI on :5173
```

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:switch   # host-native C++ tests, if you touched switch/
```

CI runs all of these plus a devkitPro `.nro` build and a Docker smoke test. Green locally is usually
green in CI.

## House style

- **Biome** handles formatting and linting. `pnpm format` before committing; do not hand-format.
- **Commit messages** are one imperative sentence, capitalised, no prefix or trailing period —
  `Advertise the server over mDNS`, `Drop the unused file hash column`. Body paragraphs are welcome
  for anything non-obvious.
- **Types are shared.** Anything crossing the web or device API belongs in `@nslib/shared` as a Zod
  schema, so the server, the web UI, the device simulator, and the C++ client stay in agreement.
- **Parsers are pure and read-only.** `@nslib/formats` reads through a `RandomAccessReader` and never
  writes. The server never writes into a library root. Keep it that way.
- **Protocol changes need golden files.** The TypeScript and C++ sides are tested against the same
  fixtures in `packages/shared/golden` and `switch/tests/golden`. Change the protocol, regenerate
  both, and make sure both suites pass.
- **Tests come with the change**, in the same commit. Vitest for TypeScript, the host-native suite in
  `switch/tests` for C++.

## Reporting bugs

Use the issue templates. For anything involving a real library, say which formats are involved
(NSP/NSZ/XCI/XCZ), whether `prod.keys` is loaded, and whether you are on LAN or USB — those three
account for most behaviour differences. Redact filenames if they identify content.

Security vulnerabilities go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Licence

Contributions are accepted under the [Apache License 2.0](LICENSE), which includes its patent grant.
By opening a pull request you confirm you wrote the code, or that you have the right to contribute it
under that licence, and that it contains no copyrighted or key material.

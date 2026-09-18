<!--
Security fix? Please go through https://github.com/tuckerwales/nslibrary/security/advisories/new
instead of opening a public PR.
-->

## What this changes

<!-- One or two sentences. Link the issue it closes, if there is one. -->

## Why

<!-- What problem this solves. Skip if the linked issue covers it. -->

## How it was tested

<!-- Commands you ran, and anything checked on real hardware. On-console behaviour (install cancel,
     USB unplug, SD full, applet memory) cannot be covered by CI — say if you tested it. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass
- [ ] `pnpm test:switch` passes (if `switch/` changed)
- [ ] Tests are included in the same commit as the change
- [ ] Shared types went into `@nslib/shared`, not one side only (if the API changed)
- [ ] Golden files regenerated and both suites pass (if the protocol changed)
- [ ] Docs updated (`README.md`, `docs/`) if behaviour or configuration changed
- [ ] No copyrighted content, key material, or real dumps in the diff, tests, or description
- [ ] I have the right to contribute this under the [Apache License 2.0](../blob/main/LICENSE)

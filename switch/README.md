# Switch homebrew

CMake project for the NSLibrary installer `.nro`. Host-native tests (no devkitPro) live in `tests/` and parse the golden fixtures (PFS0, HFS0/XCI, NCZ, USB frames, pipeline).

Build the `.nro` (needs [devkitPro](https://devkitpro.org)):

```bash
./scripts/build-switch.sh
```

Host tests: `./scripts/build-switch.sh --test`. Usage: [docs/switch.md](../docs/switch.md).

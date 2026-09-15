#!/usr/bin/env bash
# Build the Switch .nro (default) or host-native tests from the repo root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Build the NSLibrary Switch client.

Usage: scripts/build-switch.sh [options]

  (default)     Build switch/build/nslibrary.nro
  --test        Build and run host-native tests (no devkitPro)
  --forwarder   Also build the HOME-menu forwarder
  --nxlink      After a successful .nro build, run nxlink -s
  --clean       Remove the relevant build directory first
  -j N          Parallel jobs (default: nproc)
  -h, --help    Show this help
EOF
}

TARGET=nro
CLEAN=0
NXLINK=0
FORWARDER=0
if command -v nproc >/dev/null 2>&1; then
  JOBS="$(nproc)"
elif command -v sysctl >/dev/null 2>&1; then
  JOBS="$(sysctl -n hw.ncpu)"
else
  JOBS=4
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --test)
      TARGET=test
      shift
      ;;
    --forwarder)
      FORWARDER=1
      shift
      ;;
    --nxlink)
      NXLINK=1
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    -j)
      JOBS="${2:?option -j requires a job count}"
      shift 2
      ;;
    -j*)
      JOBS="${1#-j}"
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$TARGET" == test && "$NXLINK" -eq 1 ]]; then
  echo "--nxlink cannot be used with --test" >&2
  exit 2
fi
if [[ "$TARGET" == test && "$FORWARDER" -eq 1 ]]; then
  echo "--forwarder cannot be used with --test" >&2
  exit 2
fi

load_devkitpro() {
  if [[ -z "${DEVKITPRO:-}" && -f /etc/profile.d/devkit-env.sh ]]; then
    # shellcheck disable=SC1091
    source /etc/profile.d/devkit-env.sh
  fi
  if [[ -z "${DEVKITPRO:-}" && -d /opt/devkitpro ]]; then
    export DEVKITPRO=/opt/devkitpro
  fi
  if [[ -n "${DEVKITPRO:-}" ]]; then
    export DEVKITA64="${DEVKITA64:-$DEVKITPRO/devkitA64}"
    export PATH="$DEVKITPRO/tools/bin:${DEVKITA64}/bin:${PATH}"
  fi
}

require_devkitpro() {
  load_devkitpro
  if [[ -z "${DEVKITPRO:-}" || ! -f "$DEVKITPRO/cmake/Switch.cmake" ]]; then
    echo "devkitPro with Switch support is required (DEVKITPRO, switch-dev)." >&2
    echo "See docs/switch.md" >&2
    exit 1
  fi
  if ! command -v aarch64-none-elf-gcc >/dev/null 2>&1; then
    echo "aarch64-none-elf-gcc not on PATH. Is DEVKITPRO set? ($DEVKITPRO)" >&2
    exit 1
  fi
}

ensure_borealis() {
  if [[ ! -f switch/lib/borealis/library/CMakeLists.txt ]]; then
    git submodule update --init switch/lib/borealis
  fi
}

if [[ "$TARGET" == test ]]; then
  if [[ "$CLEAN" -eq 1 ]]; then
    rm -rf switch/build-host
  fi
  cmake -B switch/build-host -S switch
  cmake --build switch/build-host --target nslib-switch-tests -j"$JOBS"
  switch/build-host/nslib-switch-tests
  exit 0
fi

require_devkitpro
ensure_borealis

if [[ "$CLEAN" -eq 1 ]]; then
  rm -rf switch/build
fi

cmake -B switch/build -S switch -DPLATFORM_SWITCH=ON
cmake --build switch/build --target nslibrary.nro -j"$JOBS"

if [[ "$FORWARDER" -eq 1 ]]; then
  cmake --build switch/build --target nslibrary-forwarder -j"$JOBS"
  echo "built switch/build/forwarder-main"
fi

echo "built switch/build/nslibrary.nro"

if [[ "$NXLINK" -eq 1 ]]; then
  exec nxlink -s switch/build/nslibrary.nro
fi

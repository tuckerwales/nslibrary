#!/usr/bin/env bash
# Bump the Switch app version, build the .nro, and sign it into dist/ in one go.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Bump, build, and sign a Switch app release.

Usage: scripts/release-switch.sh [patch|minor|major|X.Y.Z] [options]

  patch|minor|major  Which part of NSLIB_VERSION to bump (default: patch)
  X.Y.Z              Set an explicit version (must be newer than the current one)
  --key-file FILE    File holding the Ed25519 seed as hex (or set NSLIB_UPDATE_SK,
                     or NSLIB_UPDATE_SK_FILE)
  --out DIR          Where to write the signed assets (default: dist)
  --no-test          Skip the host-native tests
  --clean            Remove switch/build first
  -j N               Parallel jobs (passed to build-switch.sh)
  -h, --help         Show this help

Writes <out>/nslibrary.nro, update.json and update.json.sig, then checks the
signature against the public key compiled into switch/source/update/verify.cpp.
If any step fails, the version bump in switch/CMakeLists.txt is undone.
EOF
}

BUMP=patch
KEY_FILE="${NSLIB_UPDATE_SK_FILE:-}"
OUT=dist
TEST=1
BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    patch|minor|major)
      BUMP="$1"
      shift
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      BUMP="$1"
      shift
      ;;
    --key-file)
      KEY_FILE="${2:?option --key-file requires a path}"
      shift 2
      ;;
    --out)
      OUT="${2:?option --out requires a directory}"
      shift 2
      ;;
    --no-test)
      TEST=0
      shift
      ;;
    --clean)
      BUILD_ARGS+=(--clean)
      shift
      ;;
    -j)
      BUILD_ARGS+=(-j "${2:?option -j requires a job count}")
      shift 2
      ;;
    -j*)
      BUILD_ARGS+=("$1")
      shift
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Resolve the signing key before touching anything, so a missing key fails fast.
if [[ -z "${NSLIB_UPDATE_SK:-}" ]]; then
  if [[ -z "$KEY_FILE" ]]; then
    echo "No signing key: set NSLIB_UPDATE_SK, NSLIB_UPDATE_SK_FILE, or pass --key-file." >&2
    exit 1
  fi
  if [[ ! -r "$KEY_FILE" ]]; then
    echo "Cannot read key file: $KEY_FILE" >&2
    exit 1
  fi
  NSLIB_UPDATE_SK="$(tr -d '[:space:]' <"$KEY_FILE")"
fi
if [[ ! "$NSLIB_UPDATE_SK" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
  echo "The signing key must be a 32-byte Ed25519 seed as 64 hex characters." >&2
  exit 1
fi

CMAKE=switch/CMakeLists.txt
version_part() {
  sed -n "s/^set(NSLIB_VERSION_$1 \([0-9][0-9]*\))$/\1/p" "$CMAKE"
}
MAJOR="$(version_part MAJOR)"
MINOR="$(version_part MINOR)"
PATCH="$(version_part PATCH)"
if [[ -z "$MAJOR" || -z "$MINOR" || -z "$PATCH" ]]; then
  echo "Could not read NSLIB_VERSION_{MAJOR,MINOR,PATCH} from $CMAKE" >&2
  exit 1
fi
CURRENT="$MAJOR.$MINOR.$PATCH"

case "$BUMP" in
  patch) NEXT="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  *)
    if [[ ! "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Invalid version: $BUMP" >&2
      exit 2
    fi
    NEXT="$BUMP"
    ;;
esac

# The Switch refuses an update that is not newer than the running app.
IFS=. read -r NMAJ NMIN NPAT <<<"$NEXT"
if (( NMAJ < MAJOR || (NMAJ == MAJOR && (NMIN < MINOR || (NMIN == MINOR && NPAT <= PATCH))) )); then
  echo "Version $NEXT is not newer than $CURRENT" >&2
  exit 2
fi

echo "==> Releasing $CURRENT -> $NEXT"

ORIGINAL_CMAKE="$(mktemp)"
cp "$CMAKE" "$ORIGINAL_CMAKE"
DONE=0
restore_version() {
  if [[ "$DONE" -eq 0 ]]; then
    echo "==> Release failed; restoring version $CURRENT in $CMAKE" >&2
    cp "$ORIGINAL_CMAKE" "$CMAKE"
  fi
  rm -f "$ORIGINAL_CMAKE"
}
trap restore_version EXIT

sed -i.bak \
  -e "s/^set(NSLIB_VERSION_MAJOR [0-9]*)$/set(NSLIB_VERSION_MAJOR $NMAJ)/" \
  -e "s/^set(NSLIB_VERSION_MINOR [0-9]*)$/set(NSLIB_VERSION_MINOR $NMIN)/" \
  -e "s/^set(NSLIB_VERSION_PATCH [0-9]*)$/set(NSLIB_VERSION_PATCH $NPAT)/" \
  "$CMAKE"
rm -f "$CMAKE.bak"

if [[ "$TEST" -eq 1 ]]; then
  echo "==> Running host tests"
  bash scripts/build-switch.sh --test ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
fi

echo "==> Building nslibrary.nro"
bash scripts/build-switch.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

echo "==> Signing into $OUT"
NSLIB_UPDATE_SK="$NSLIB_UPDATE_SK" node scripts/sign-update.mjs switch/build/nslibrary.nro --out "$OUT" --version "$NEXT"

echo "==> Verifying against the app's public key"
node --input-type=module - "$OUT" <<'EOF'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBytes } from "./scripts/update-keys.mjs";

const out = process.argv[2];
const source = readFileSync("switch/source/update/verify.cpp", "utf8");
const block = source.match(/kProductionUpdatePublicKey\[32\]\s*=\s*\{([^}]*)\}/);
const bytes = block ? [...block[1].matchAll(/0x([0-9a-fA-F]{2})/g)].map((m) => m[1]) : [];
if (bytes.length !== 32) throw new Error("Could not read kProductionUpdatePublicKey from verify.cpp");
const publicKey = Buffer.from(bytes.join(""), "hex");

const json = readFileSync(join(out, "update.json"));
const sig = readFileSync(join(out, "update.json.sig"));
const nro = readFileSync(join(out, "nslibrary.nro"));
const manifest = JSON.parse(json);
const problems = [];
if (!verifyBytes(publicKey, json, sig)) problems.push("signature does not match the app's public key");
if (nro.byteLength !== manifest.size) problems.push("nro size does not match update.json");
if (createHash("sha256").update(nro).digest("hex") !== manifest.sha256) {
  problems.push("nro sha256 does not match update.json");
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("signature, size and sha256 verified");
EOF

DONE=1
cat <<EOF

Released $NEXT into $OUT/ (nslibrary.nro, update.json, update.json.sig).
Next: commit $CMAKE, tag v$NEXT, and publish the three files
(GitHub Release and/or the server's data/update/ folder).
EOF

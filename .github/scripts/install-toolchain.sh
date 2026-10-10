#!/usr/bin/env bash
# Installs the non-npm toolchain at exact, hash-verified versions:
#   nargo (Noir), bb (Barretenberg), forge/cast/anvil (Foundry).
# Used by CI (.github/actions/setup with toolchain: "true", and repro-build)
# and by sessions on demand.
#
# Pins (see AGENTS.md "Toolchain pins"): Noir is 1.0.0-beta.22 and bb is the
# version bbup's bb-versions.json maps to it. @noir-lang/noir_js and
# @aztec/bb.js in pnpm-workspace.yaml must match. Upgrade all four together in
# one PR, and only once bb-versions.json lists the new Noir version.
#
# Usage: .github/scripts/install-toolchain.sh [install-dir]   (default: ~/.local/abolish-toolchain/bin)
set -euo pipefail

NOIR_VERSION="1.0.0-beta.22"
BB_VERSION="5.0.0-nightly.20260522"
# Evidence for the Noir -> bb mapping, recorded 2026-10-09: bbup's
# barretenberg/bbup/bb-versions.json at this AztecProtocol/aztec-packages
# commit (on next) has this sha256 and maps NOIR_VERSION to BB_VERSION. Not
# used below; CI's toolchain check (.github/tools/ci/src/toolchain.ts) re-fetches
# the file by commit and from next and checks the mapping. Keep each of these
# four as one top-level NAME="literal" line: the check refuses anything else.
# shellcheck disable=SC2034
BB_VERSIONS_COMMIT="bb15fcbbe969f11a892272715fe59f0976b086ca"
# shellcheck disable=SC2034
BB_VERSIONS_SHA256="26f98a191cfc049521320d077473a12cf141ff9b909392f4685d349063a5b2f8"
FOUNDRY_VERSION="1.8.3"

declare -A SHA256=(
  ["nargo-x86_64-unknown-linux-gnu.tar.gz"]="384c4fc800905b213e26aabd738a96a4a85b1a76ffc27fb19aeb6d33494a787b"
  ["nargo-aarch64-apple-darwin.tar.gz"]="445dac99258f867b016a05353eac7bf7c1cfee26b98b68cc851bb57ec569a91c"
  ["barretenberg-amd64-linux.tar.gz"]="d207ec90fbfa2fba24d7a47b7a75892ee052b7984252b866a4a0c1b5296e1571"
  ["barretenberg-arm64-darwin.tar.gz"]="f566c48ba0dace70a7a3464dae1157c6e69b5260b1e2ec0f579713f9e7a70300"
  ["foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz"]="7ca48e6ca3cac1bce1403ca67e5bc1dc3bc1fd818199c9957c7165079c228568"
  ["foundry_v${FOUNDRY_VERSION}_darwin_arm64.tar.gz"]="562f9c2f9094e512f1efc1e005c79de7642c27ffc1e7e9dcf8e31baa54577d6e"
)

BIN_DIR="${1:-$HOME/.local/abolish-toolchain/bin}"
mkdir -p "$BIN_DIR"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) NARGO_ASSET="nargo-x86_64-unknown-linux-gnu.tar.gz"; BB_ASSET="barretenberg-amd64-linux.tar.gz"; FOUNDRY_PLATFORM="linux_amd64" ;;
  Darwin-arm64) NARGO_ASSET="nargo-aarch64-apple-darwin.tar.gz"; BB_ASSET="barretenberg-arm64-darwin.tar.gz"; FOUNDRY_PLATFORM="darwin_arm64" ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
FOUNDRY_ASSET="foundry_v${FOUNDRY_VERSION}_${FOUNDRY_PLATFORM}.tar.gz"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

fetch_verified() { # url asset dest-dir [tar members...]
  local url="$1" asset="$2" dest="$3"
  shift 3
  local tmp
  tmp="$(mktemp -d)"
  curl -sSfL --retry 4 --retry-delay 2 -o "$tmp/$asset" "$url"
  local got expected="${SHA256[$asset]}"
  got="$(sha256 "$tmp/$asset")"
  if [ "$got" != "$expected" ]; then
    echo "sha256 mismatch for $asset: got $got, expected $expected" >&2
    rm -rf "$tmp"
    exit 1
  fi
  tar xzf "$tmp/$asset" -C "$dest" "$@"
  rm -rf "$tmp"
}

have_version() { # binary expected-substring
  [ -x "$BIN_DIR/$1" ] && "$BIN_DIR/$1" --version 2>/dev/null | grep -qF "$2"
}

if ! have_version nargo "nargo version = $NOIR_VERSION"; then
  fetch_verified "https://github.com/noir-lang/noir/releases/download/v${NOIR_VERSION}/${NARGO_ASSET}" "$NARGO_ASSET" "$BIN_DIR" nargo
fi
if ! have_version bb "$BB_VERSION"; then
  fetch_verified "https://github.com/AztecProtocol/barretenberg/releases/download/v${BB_VERSION}/${BB_ASSET}" "$BB_ASSET" "$BIN_DIR" bb
fi
if ! have_version forge "forge Version: $FOUNDRY_VERSION"; then
  fetch_verified "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/${FOUNDRY_ASSET}" "$FOUNDRY_ASSET" "$BIN_DIR" forge cast anvil chisel
fi

"$BIN_DIR/nargo" --version | head -1
echo "bb $("$BIN_DIR/bb" --version)"
"$BIN_DIR/forge" --version | head -1

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$BIN_DIR" >>"$GITHUB_PATH"
else
  echo "add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
fi

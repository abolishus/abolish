#!/usr/bin/env bash
# The steps of the staging contract deployment (.github/workflows/
# testnet-deploy.yml; P2-32 part 3b; packages/contracts/README.md, Deploy
# script and Confirming a deployment). Threats: T-64, T-34, T-65, T-56.
#
# Every RPC URL is read from the environment, never an argument: a provider's
# URL can carry its key, and arguments end up in logs.
#
#   config                          print DEPLOY_CONFIG for this commit: the
#                                   owner's TESTNET_DEPLOY_CONFIG with the
#                                   checkout's commit and the deployer's nonce
#                                   on each chain added (L1_RPC_URL, L2_RPC_URL)
#   fork <port>                     fork the chain at RPC_URL into a local
#                                   Anvil that sends as any account, and fund
#                                   DEPLOYER on it; print the fork's URL
#   deploy <config> [wallet...]     runL1() then runL2(), broadcasting as the
#                                   config's deployer with forge's wallet
#                                   arguments (L1_RPC_URL, L2_RPC_URL)
#   confirm <config> <artifacts> <out>
#                                   script/confirm.ts over both records against
#                                   <artifacts>, writing <out>/<chain-id>.json
#                                   (L1_RPC_URL, L2_RPC_URL; needs vp)
#   finalized <record>              wait until the chain at RPC_URL has
#                                   finalized every block <record> names
#   verify <record> <artifacts>     verify each contract's source on the
#                                   explorer (ETHERSCAN_API_KEY)
#   digest <dir>                    print one sha256 over every file in <dir>
#
# Paths are taken relative to the directory the script is run from; it runs
# forge and confirm.ts in packages/contracts itself.
set -euo pipefail

CONTRACTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/contracts" && pwd)"
# The only pair the deploy script accepts for staging while any of
# [[0044-testnet-deployments]]'s conditions is open; forks keep these IDs.
L1_CHAIN=11155111
L2_CHAIN=84532

fail() {
  echo "::error::$*" >&2
  exit 1
}

abspath() {
  printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}

# Forge's output goes to a file, not the job's pipe: node tasks earlier in a
# job leave that pipe non-blocking, and forge panics when a write to it
# returns EAGAIN.
quiet() {
  local log
  log="$(mktemp)"
  if ! "$@" >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    return 1
  fi
  cat "$log"
  rm -f "$log"
}

config() {
  local base="${TESTNET_DEPLOY_CONFIG:?TESTNET_DEPLOY_CONFIG is not set}"
  # The run adds the commit and the nonces: a commit other than the one
  # checked out, or a stale nonce, would only be refused later, by the script.
  jq -e 'type == "object" and ([has("commit", "l1Nonce", "l2Nonce")] | any | not)' \
    <<<"$base" >/dev/null ||
    fail "TESTNET_DEPLOY_CONFIG must be a JSON object without commit, l1Nonce or l2Nonce"
  [[ "$(jq -r .l1ChainId <<<"$base")" == "$L1_CHAIN" && "$(jq -r .l2ChainId <<<"$base")" == "$L2_CHAIN" ]] ||
    fail "TESTNET_DEPLOY_CONFIG must name Sepolia ($L1_CHAIN) and Base Sepolia ($L2_CHAIN)"
  local deployer
  deployer="$(jq -r .deployer <<<"$base")"
  [[ "$deployer" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "TESTNET_DEPLOY_CONFIG's deployer isn't an address"
  local chain url id nonce l1Nonce l2Nonce
  for chain in l1 l2; do
    if [[ "$chain" == l1 ]]; then url="${L1_RPC_URL:?}" id="$L1_CHAIN"; else url="${L2_RPC_URL:?}" id="$L2_CHAIN"; fi
    [[ "$(ETH_RPC_URL="$url" cast chain-id)" == "$id" ]] || fail "the ${chain^^} RPC isn't chain $id"
    nonce="$(ETH_RPC_URL="$url" cast nonce "$deployer")"
    if [[ "$chain" == l1 ]]; then l1Nonce="$nonce"; else l2Nonce="$nonce"; fi
  done
  jq --arg commit "$(git -C "$CONTRACTS" rev-parse HEAD)" \
    --argjson l1Nonce "$l1Nonce" --argjson l2Nonce "$l2Nonce" \
    '. + { commit: $commit, l1Nonce: $l1Nonce, l2Nonce: $l2Nonce }' <<<"$base"
}

fork() {
  local port="$1" url="http://127.0.0.1:$1"
  anvil --fork-url "${RPC_URL:?}" --host 127.0.0.1 --port "$port" --auto-impersonate --silent \
    </dev/null >/dev/null 2>&1 &
  local i
  for ((i = 0; i < 120; i++)); do
    if ETH_RPC_URL="$url" cast chain-id >/dev/null 2>&1; then
      # 1,000 ether: the fork's gas, never the chain's.
      ETH_RPC_URL="$url" cast rpc anvil_setBalance "${DEPLOYER:?}" 0x3635c9adc5dea00000 >/dev/null
      echo "$url"
      return
    fi
    sleep 1
  done
  fail "the fork on port $port didn't start"
}

deploy() {
  local config deployer
  config="$(abspath "$1")"
  shift
  deployer="$(jq -r .deployer "$config")"
  cd "$CONTRACTS"
  # --slow sends each transaction only after the previous one succeeded, so
  # one failing can't leave later nonces, and so CREATE addresses, shifted.
  # The L2 run reads the L1 contracts at L1_RPC_URL, which forge inherits.
  DEPLOY_CONFIG="$(cat "$config")" quiet forge script script/Deploy.s.sol:Deploy \
    --sig 'runL1()' --rpc-url "${L1_RPC_URL:?}" --broadcast --slow --sender "$deployer" "$@"
  # On Base Sepolia forge 1.8.3 simulates with op-revm, which panics reading
  # the L1Block predeploy ("Missing operator fee scalar for isthmus L1
  # Block"), so the L2 run simulates on Ethereum's EVM. The simulation only
  # sizes each transaction's gas; the chain charges its L1 data fee apart
  # from the gas limit, and confirm.ts checks what was actually deployed.
  DEPLOY_CONFIG="$(cat "$config")" quiet forge script script/Deploy.s.sol:Deploy \
    --sig 'runL2()' --rpc-url "${L2_RPC_URL:?}" --network ethereum --broadcast --slow \
    --sender "$deployer" "$@"
}

confirm() {
  local config artifacts out
  config="$(abspath "$1")" artifacts="$(abspath "$2")" out="$(abspath "$3")"
  mkdir -p "$out"
  cd "$CONTRACTS"
  RPC_URL="${L1_RPC_URL:?}" vp node script/confirm.ts "deployments/$L1_CHAIN.json" \
    "broadcast/Deploy.s.sol/$L1_CHAIN/runL1-latest.json" "$artifacts" >"$out/$L1_CHAIN.json"
  RPC_URL="${L2_RPC_URL:?}" vp node script/confirm.ts "deployments/$L2_CHAIN.json" \
    "broadcast/Deploy.s.sol/$L2_CHAIN/runL2-latest.json" "$artifacts" >"$out/$L2_CHAIN.json"
  # The records the script wrote are the deployment the config describes.
  jq -e --slurpfile c "$config" '.commit == $c[0].commit and .deployer == $c[0].deployer' \
    "$out/$L1_CHAIN.json" "$out/$L2_CHAIN.json" >/dev/null ||
    fail "the records aren't this run's commit and deployer"
}

record() {
  local confirmed out inputs
  confirmed="$(abspath "$1")" out="$(abspath "$2")"
  local base="${TESTNET_DEPLOYMENT_INPUTS:?TESTNET_DEPLOYMENT_INPUTS is not set}"
  mkdir -p "$out"
  # The owner can't know the L2's first block before the run: it is the
  # first block that created one of the L2 contracts, as confirmed.
  jq -e 'type == "object" and (has("l2FromBlock") | not)' <<<"$base" >/dev/null ||
    fail "TESTNET_DEPLOYMENT_INPUTS must be a JSON object without l2FromBlock: the run adds it"
  inputs="$out/inputs.json"
  jq --slurpfile l2 "$confirmed/$L2_CHAIN.json" \
    '. + { l2FromBlock: ([$l2[0].contracts[].block] | min | tostring) }' <<<"$base" >"$inputs"
  local admin="$CONTRACTS/../../apps/admin-cli/src/main.ts"
  local files=(--l1 "$confirmed/$L1_CHAIN.json" --l2 "$confirmed/$L2_CHAIN.json" --inputs "$inputs")
  vp node "$admin" deployment record "${files[@]}" >"$out/record.json"
  vp node "$admin" deployment variables "${files[@]}" \
    --coordinator "${STAGING_COORDINATOR_URL:?STAGING_COORDINATOR_URL is not set}" >"$out/variables.json"
}

finalized() {
  local want have deadline=$((SECONDS + 5400))
  want="$(jq -e '[.contracts[].block] | max' "$1")"
  while :; do
    have="$(ETH_RPC_URL="${RPC_URL:?}" cast block finalized --field number)"
    ((have >= want)) && return
    ((SECONDS < deadline)) || fail "block $want of chain $(jq .chainId "$1") wasn't finalized within 90 minutes"
    sleep 30
  done
}

verify() {
  local record artifacts broadcast chain name address tx input bytecode args
  record="$(abspath "$1")" artifacts="$(abspath "$2")"
  chain="$(jq -r .chainId "$record")"
  cd "$CONTRACTS"
  broadcast="$(ls broadcast/Deploy.s.sol/"$chain"/run*-latest.json)"
  while read -r name address tx; do
    [[ "$name" =~ ^[A-Za-z0-9]+$ ]] || fail "unexpected contract name in the record"
    # A contract's constructor arguments follow its creation code in the
    # transaction that ran it (confirm.ts checked that prefix). A contract
    # another constructor created, such as the board's ballot check, has
    # its creator's transaction, and takes no arguments.
    input="$(jq -r --arg tx "$tx" '.transactions[] | select(.hash == $tx) | .transaction.input' "$broadcast")"
    bytecode="$(jq -r .bytecode.object "$artifacts/$name.sol/$name.json")"
    args=0x
    if [[ "${input,,}" == "${bytecode,,}"* ]]; then args="0x${input:${#bytecode}}"; fi
    quiet forge verify-contract "$address" "src/$name.sol:$name" --chain "$chain" \
      --constructor-args "$args" --watch
  done < <(jq -r '.contracts | to_entries[] | "\(.key) \(.value.address) \(.value.transaction)"' "$record")
}

digest() {
  (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1
}

command="${1:-}"
shift || true
case "$command" in
  config | fork | deploy | confirm | record | finalized | verify | digest) "$command" "$@" ;;
  *)
    echo "usage: $0 config|fork|deploy|confirm|record|finalized|verify|digest ..." >&2
    exit 2
    ;;
esac

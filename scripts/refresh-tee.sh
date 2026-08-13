#!/usr/bin/env bash
# refresh-tee.sh — heal the hosted TEE registration after a restart.
#
# tee-node keeps its identity in memory, so every container restart produces a
# new TEE address and silently orphans the on-chain registration: the old
# machine still reads status 2 and still gets pinned by createAuction, but
# nobody is running it, so bids can never be cleared. On a free-tier host
# restarts are routine, which makes this the failure mode that actually bites.
#
# This registers whatever identity the proxy is serving now and pauses every
# machine that is no longer it.
#
# Scope, deliberately: it only acts when the live identity is not already the
# sole active machine. Re-registering an unchanged identity is NOT a no-op —
# the attestation request reverts on a machine that is already registered — so
# a healthy stack is left alone rather than poked every run.
#
# Not covered: availability proofs age out (~6h per Flare's FCC notes) and
# there is no supported way to refresh one without re-registering. If a stack
# that never restarted stops receiving instructions, force a re-register by
# pausing the live machine first, then running this.
#
# Required env:
#   DEPLOYMENT_PRIVATE_KEY   owner of the machines (also pays gas)
#   EXT_PROXY_URL            public HTTPS URL of the extension proxy
# Optional:
#   CHAIN_URL, NORMAL_PROXY_URL, EXTENSION_ID_DEC, ADDRESSES_FILE, TEE_MANAGER
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# .env fills in what the caller did not supply, but never overrides it: CI
# passes settings explicitly, and a stale local .env must not win over them.
_KEYS=(EXT_PROXY_URL CHAIN_URL NORMAL_PROXY_URL EXTENSION_ID_DEC
       DEPLOYMENT_PRIVATE_KEY TEE_MANAGER ADDRESSES_FILE SIMULATED_TEE CAST_CHAIN)
declare -A _PRESET=()
for _k in "${_KEYS[@]}"; do
    [[ -n "${!_k:-}" ]] && _PRESET["$_k"]="${!_k}"
done

if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi

for _k in "${!_PRESET[@]}"; do
    printf -v "$_k" '%s' "${_PRESET[$_k]}"
    export "${_k?}"
done

CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
NORMAL_PROXY_URL="${NORMAL_PROXY_URL:-https://tee-proxy-coston2-1.flare.rocks}"
EXTENSION_ID_DEC="${EXTENSION_ID_DEC:-66046}"
TEE_MANAGER="${TEE_MANAGER:-0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE}"
ADDRESSES_FILE="${ADDRESSES_FILE:-$PROJECT_DIR/config/coston2/deployed-addresses.json}"
[[ "$ADDRESSES_FILE" != /* ]] && ADDRESSES_FILE="$PROJECT_DIR/${ADDRESSES_FILE#./}"

# foundry auto-loads .env from the working directory, so this repo's
# CHAIN=coston2 (used by our own scripts to pick an addresses file) reaches cast
# as `--chain coston2`, which is not a name foundry knows. Passing foundry's own
# name explicitly overrides it; --rpc-url still decides the endpoint.
CAST_CHAIN="${CAST_CHAIN:-flare-coston2}"

die() { echo "[refresh-tee] ERROR: $*" >&2; exit 1; }
log() { echo "[refresh-tee] $*"; }

: "${DEPLOYMENT_PRIVATE_KEY:?set DEPLOYMENT_PRIVATE_KEY}"
: "${EXT_PROXY_URL:?set EXT_PROXY_URL}"

# --- the identity the proxy is serving right now ---------------------------
# Parsed with grep rather than jq so this runs anywhere cast does (Git Bash on
# Windows has no jq). The key fields are the first x/y in the payload.
info="$(curl -sf --max-time 120 "$EXT_PROXY_URL/info")" || die "proxy unreachable at $EXT_PROXY_URL"
px="$(grep -oE '"x":"0x[0-9a-fA-F]+"' <<<"$info" | head -1 | grep -oE '0x[0-9a-fA-F]+')"
py="$(grep -oE '"y":"0x[0-9a-fA-F]+"' <<<"$info" | head -1 | grep -oE '0x[0-9a-fA-F]+')"
[[ "$px" == 0x* && "$py" == 0x* ]] || die "could not read the TEE public key from /info"

hash="$(cast keccak "0x${px#0x}${py#0x}")"
LIVE="0x${hash: -40}"
log "live TEE:  $LIVE"

# --- what does the registry think is running? ------------------------------
active="$(cast call "$TEE_MANAGER" "getActiveTeeMachines(uint256)(address[])" \
    "$EXTENSION_ID_DEC" --rpc-url "$CHAIN_URL" --chain "$CAST_CHAIN")"
log "active machines: $active"

active_list="$(grep -oiE '0x[0-9a-f]{40}' <<<"$active" || true)"
active_count="$(grep -c . <<<"${active_list:-}" || true)"
[[ -z "$active_list" ]] && active_count=0

if [[ "$active_count" == "1" ]] && grep -qi "${LIVE#0x}" <<<"$active_list"; then
    log "healthy — the live TEE is already the only active machine, nothing to do"
    exit 0
fi

# --- register the identity the proxy is actually serving -------------------
if grep -qi "${LIVE#0x}" <<<"${active_list:-}"; then
    log "live TEE is registered but shares the extension with stale machines — retiring those only"
else
    log "live TEE is not registered (restart rotated the identity) — registering…"
    (
        cd "$PROJECT_DIR/tools"
        SIMULATED_TEE="${SIMULATED_TEE:-true}" go run ./cmd/register-tee \
            -a "$ADDRESSES_FILE" \
            -c "$CHAIN_URL" \
            -p "$EXT_PROXY_URL" \
            -h "$EXT_PROXY_URL" \
            -ep "$NORMAL_PROXY_URL" \
            -command rRap \
            -state "$PROJECT_DIR/config/register-tee.state"
    ) || die "register-tee failed"

    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$PROJECT_DIR/config/last-register.txt"

    active="$(cast call "$TEE_MANAGER" "getActiveTeeMachines(uint256)(address[])" \
        "$EXTENSION_ID_DEC" --rpc-url "$CHAIN_URL" --chain "$CAST_CHAIN")"
    log "active after registering: $active"
fi

retired=0
for addr in $(grep -oiE '0x[0-9a-f]{40}' <<<"$active"); do
    if [[ "${addr,,}" != "${LIVE,,}" ]]; then
        log "pausing retired machine $addr"
        cast send "$TEE_MANAGER" "pause(address)" "$addr" \
            --rpc-url "$CHAIN_URL" --chain "$CAST_CHAIN" \
            --private-key "$DEPLOYMENT_PRIVATE_KEY" >/dev/null \
            || die "failed to pause $addr"
        retired=$((retired + 1))
    fi
done

final="$(cast call "$TEE_MANAGER" "getActiveTeeMachines(uint256)(address[])" \
    "$EXTENSION_ID_DEC" --rpc-url "$CHAIN_URL" --chain "$CAST_CHAIN")"
log "done — retired $retired, active now: $final"

grep -qi "${LIVE#0x}" <<<"$final" || die "the live TEE is not in the active set after refresh"

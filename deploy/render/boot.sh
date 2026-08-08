#!/bin/bash
# Boot script for the single-container Render deployment: redis + tee-proxy +
# tee-node + the QuietFill extension + the CORS edge, all on localhost. If any
# process dies the container exits and Render restarts it.
set -u

: "${PROXY_PRIVATE_KEY:?set PROXY_PRIVATE_KEY (funded Coston2 key for proxy signing)}"
: "${DB_HOST:?set DB_HOST (Flare indexer database host)}"
: "${DB_NAME:?set DB_NAME}"
: "${DB_USER:?set DB_USER}"
: "${DB_PASSWORD:?set DB_PASSWORD}"

CHAIN_ID="${CHAIN_ID:-114}"
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
DB_PORT="${DB_PORT:-3306}"

if [[ -z "${EXTENSION_ID:-}" ]]; then
  echo "WARNING: EXTENSION_ID is not set — run pre-build.sh locally first and set it" >&2
fi
if [[ -z "${INITIAL_OWNER:-}" ]]; then
  echo "WARNING: INITIAL_OWNER is not set — the TEE will refuse to register" >&2
fi

# --- proxy config, generated from env so no credentials live in the repo ---
mkdir -p /app/proxy/config
# Field set follows tee-proxy's config.example.toml at the pinned commit
# (0c6d016): newer fields are stated explicitly so none land on a zero value.
# machine_path_manager stays zero (direct-signature governance, [governance]
# unset) and attestation stays off (SIMULATED_TEE deployment).
cat > /app/proxy/config/config.toml <<EOF
redis_port = "127.0.0.1:6379"
private_key_variable = "PROXY_PRIVATE_KEY"
initial_signing_policy_offset = 2
signing_policy_fetch_interval = "20s"
machine_path_list_fetch_interval = "10m"
db_sync_max_sleep_time = "10m"

chain_id = ${CHAIN_ID}

[db]
host = "${DB_HOST}"
port = ${DB_PORT}
database = "${DB_NAME}"
username = "${DB_USER}"
password = "${DB_PASSWORD}"
log_queries = false

[logging]
level = "${LOG_LEVEL:-INFO}"
file = ""
max_file_size = 0
console = true

[addresses]
flare_systems_manager = "${FLARE_SYSTEMS_MANAGER:-0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52}"
relay = "${RELAY:-0xa10B672D1c62e5457b17af63d4302add6A99d7dE}"
voter_registry = "${VOTER_REGISTRY:-0x6a0AF07b7972177B176d3D422555cbc98DfDe914}"
machine_path_manager = "0x0000000000000000000000000000000000000000"

[ports]
internal = "6663"
external = "6664"

[info_timing]
initial_timeout = "5m"
cycle_internal = "10s"
cycle_queue_response_wait = "2s"

[voting]
proposal_expiration = "120s"
max_pending_request = 10000
history_size = 3
finalized_buffer_size = 10
max_provider_vote = 0.025

[storage]
action_ttl = "336h"
result_ttl = "336h"
submit_result_ttl = "30m"
backup_ttl = "192h"

[direct]
enable = false

[attestation]
enable = false

[metrics]
enable = false
EOF
echo "boot: proxy config generated (db ${DB_HOST}:${DB_PORT}, chain ${CHAIN_ID})"

if [[ "${GENERATE_ONLY:-0}" == "1" ]]; then
  cat /app/proxy/config/config.toml
  exit 0
fi

# --- processes -------------------------------------------------------------
redis-server --save "" --appendonly no --port 6379 --bind 127.0.0.1 &
REDIS_PID=$!

(cd /app/proxy && exec ./main) &
PROXY_PID=$!

export MODE="${MODE:-1}"
export CONFIG_PORT=5501 SIGN_PORT=7701 EXTENSION_PORT=7702
export PROXY_URL="http://127.0.0.1:6663"
export CHAIN_ID CHAIN_URL
export SIMULATED_TEE="${SIMULATED_TEE:-true}"
export GOVERNANCE_SIGNERS="${GOVERNANCE_SIGNERS:-${INITIAL_OWNER:-}}"
export GOVERNANCE_THRESHOLD="${GOVERNANCE_THRESHOLD:-1}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"

/app/server &
TEE_PID=$!

node /app/extension/dist/main.js &
EXT_PID=$!

node /app/edge.js &
EDGE_PID=$!

echo "boot: redis=$REDIS_PID proxy=$PROXY_PID tee=$TEE_PID ext=$EXT_PID edge=$EDGE_PID"

wait -n $REDIS_PID $PROXY_PID $TEE_PID $EXT_PID $EDGE_PID
echo "boot: a process exited — shutting down for restart" >&2
kill -TERM $REDIS_PID $PROXY_PID $TEE_PID $EXT_PID $EDGE_PID 2>/dev/null
exit 1

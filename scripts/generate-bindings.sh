#!/usr/bin/env bash
# generate-bindings.sh — Compile Solidity contracts and generate Go bindings.
#
# Prerequisites: forge (Foundry), jq
#
# Usage: ./scripts/generate-bindings.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Contract name and Go package ---
CONTRACT_NAME="QuietFillAuction"
GO_PKG="quietfill"
BINDINGS_DIR="$PROJECT_DIR/tools/pkg/contracts/$GO_PKG"

cd "$PROJECT_DIR"

echo "=== Step 1: Compile Solidity contracts ==="
forge build

# Verify the contract name in the source matches what we expect
if ! grep -q "contract ${CONTRACT_NAME}" "$PROJECT_DIR/contracts/InstructionSender.sol" 2>/dev/null; then
    echo ""
    echo "ERROR: Contract name '${CONTRACT_NAME}' not found in contracts/InstructionSender.sol."
    echo "Make sure the contract name in InstructionSender.sol matches CONTRACT_NAME in this script."
    exit 1
fi

echo "=== Step 2: Extract ABI and BIN ==="
extract() {
    local forge_out="$1" contract="$2" dir="$3"
    if [[ ! -f "$forge_out" ]]; then
        echo "ERROR: forge output not found at $forge_out"
        echo "Check that the contract name matches your Solidity contract name."
        exit 1
    fi
    mkdir -p "$dir"
    jq '.abi' "$forge_out" > "$dir/${contract}.abi"
    jq -r '.bytecode.object' "$forge_out" | sed 's/^0x//' > "$dir/${contract}.bin"
    echo "  ABI → $dir/${contract}.abi"
    echo "  BIN → $dir/${contract}.bin"
}

extract "$PROJECT_DIR/out/InstructionSender.sol/${CONTRACT_NAME}.json" "$CONTRACT_NAME" "$BINDINGS_DIR"
extract "$PROJECT_DIR/out/TestToken.sol/TestToken.json" "TestToken" "$PROJECT_DIR/tools/pkg/contracts/testtoken"

echo "=== Step 3: Generate Go bindings ==="
cd "$PROJECT_DIR/tools"
go generate ./pkg/contracts/$GO_PKG/ ./pkg/contracts/testtoken/

echo "=== Done ==="
echo "Generated: $BINDINGS_DIR/autogen.go"

# QuietFill Development Handoff

QuietFill is a real, non-gambling fixed-lot RFQ auction for FXRP/USDT0 on Flare Coston2. Sellers escrow FXRP, dealers escrow the same public USDT0 ceiling, bids remain encrypted, and Flare Confidential Compute chooses the best eligible price. The final product must be a publicly deployed application with live Coston2 transactions and a continuously reachable FCC proxy. A localhost-only demo is not acceptable.

## Start Here

Run these checks before changing code:

```bash
git status --short --branch
forge test
cd typescript
npm ci
npm run typecheck
npm test
npm run build
```

Use Node 24. Do not add secrets, private keys, indexer credentials, deployment state, or private planning material to Git. `.internal/`, `.env*`, proxy credentials, and `DEPLOYMENT.md` are intentionally ignored.

## Current Implementation

The TypeScript FCC extension implements:

- `QUIETFILL / PRIVATE_BID`: decrypt an ECIES ciphertext, ABI-decode the private bid, enforce monotonic bidder nonces, and store only the latest bid per bidder.
- `QUIETFILL / CLEAR`: select the highest bid inside the immutable on-chain floor/ceiling collar, with deterministic address tie-breaking.
- Price-free public receipts and state. Bid prices must never be exposed by `/state`, logs, or the bid receipt.

The Solidity contract in `contracts/InstructionSender.sol` implements:

- Seller FXRP escrow and dealer USDT0 ceiling escrow.
- One ceiling deposit per dealer, reused for encrypted replacement bids.
- One Flare-registry-selected TEE pinned per auction. Every bid and the clear request for that auction must go to that same TEE.
- On-chain verification of the exact chain-bound `TEE_ACTION_RESULT` signature produced by the scaffold's pinned `tee-node` revision.
- Atomic winner settlement, spread refund, pull-based loser refunds, no-fill recovery, timeout cancellation, replay rejection, and reentrancy protection.

Security invariants that must not be weakened:

1. The browser or relayer never decides the winner.
2. Settlement recovers the TEE address pinned in the auction; there is no owner-settable settlement signer.
3. The signed result must bind `address(this)`, `auctionId`, winner, price, nonce, commitment, and counts.
4. A winner without full public ceiling escrow cannot settle.
5. Every terminal path lets the seller recover FXRP and every non-winning dealer recover USDT0.
6. An auction must have a timeout path if the hosted TEE or proxy becomes unavailable.

Contract tests live in `test/QuietFillAuction.t.sol`. They cover valid settlement, forged signatures, relayer tampering, replay, an unescrowed winner, no-fill, timeout recovery, late bids, replacement bids, and registry-selected TEE pinning.

## Exact Flare Signature Format

The contract deliberately mirrors the versions pinned by the scaffold:

- `tee-node`: `31fc839ae6d2`
- `go-flare-common`: `c573c79c0924`
- Domain: `bytes32("TEE_ACTION_RESULT")`
- Action result hash: `keccak256(keccak256(data) || instructionId || keccak256("threshold") || uint8(1))`
- Payload hash: `keccak256(abi.encode(domain, block.chainid, actionResultHash))`
- Recovery digest: EIP-191 `personal_sign` wrapping of the payload hash

Do not replace this with a generic `signMessage(data)` assumption or accept an unsigned proxy response.

## Resume Work in This Order

### 1. Generate Go bindings on a machine with adequate disk space

The previous machine's Windows C: drive had only about 2.6 GB free, so Docker-based binding generation was intentionally stopped. The Solidity ABI and BIN were extracted locally, but generated artifacts are ignored and `autogen.go` was not completed.

Preferred: install Go 1.25.1+ directly, then run:

```bash
./scripts/generate-bindings.sh
```

Docker fallback, only on a machine with sufficient Docker storage:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e GOCACHE=/tmp/go-cache \
  -e GOPATH=/tmp/go \
  -v "$PWD:/workspace" \
  -w /workspace/tools \
  golang:1.25.1 \
  go generate ./pkg/contracts/quietfill/
```

### 2. Finish Flare deployment-tool integration

- Change `tools/pkg/utils/instructions.go` from the old `helloworld` binding to `quietfill`.
- Deploy `QuietFillAuction` with four constructor arguments: Flare TEE extension registry, Flare TEE machine registry, FXRP token, and USDT0 token.
- Make `tools/cmd/deploy-contract` require explicit base/quote token addresses and verify both addresses contain contract code before deployment.
- Update `tools/cmd/run-test` to send an encrypted private bid and clear request, poll the proxy, then relay the returned signed clear result into `settleAuction`.
- Do not invent token addresses. Resolve or verify current Coston2 FXRP and USDT0 addresses against official Flare sources and confirm `symbol()` and `decimals()` over RPC.

### 3. Complete the live product

- Build a seller/dealer web app using wagmi/viem.
- Fetch the selected TEE public key and encrypt bids in the dealer's browser.
- Poll the hosted extension proxy for receipts and the signed clear result.
- Relay the signed result on-chain and display explorer-linked evidence.
- Deploy the contract to Coston2, register the extension, keep the public proxy running, and deploy the frontend.
- Run a real multi-wallet auction with faucet FXRP/USDT0 and preserve transaction hashes, contract addresses, extension ID, TEE ID, proxy URL, and screenshots/video.

## Repository Provenance

The repository intentionally retains Flare Foundation's official `fce-extension-scaffold` history. `upstream` points to the Flare repository and `origin` points to `N-45div/Quietfill`. QuietFill-specific work starts at commit `d719b2e`. Keep a clear public "built during the hackathon" section rather than squashing away scaffold provenance.


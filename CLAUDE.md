# QuietFill Development Handoff

QuietFill is a real, non-gambling fixed-lot RFQ auction for FXRP/USDT0 on Flare Coston2. Sellers escrow FXRP, dealers escrow the same public USDT0 ceiling, bids remain encrypted, and Flare Confidential Compute chooses the best eligible price. The final product must be a publicly deployed application with live Coston2 transactions and a continuously reachable FCC proxy. A localhost-only demo is not acceptable.

## Start Here

Run these checks before changing code:

```bash
git status --short --branch
forge test
cd typescript && npm ci && npm run typecheck && npm test && npm run build
cd ../web && npm ci && npm run typecheck && npm test && npm run build
```

Use Node 24. Do not add secrets, private keys, indexer credentials, deployment state, or private planning material to Git. `.internal/`, `.env*`, proxy credentials, and `DEPLOYMENT.md` are intentionally ignored.

## Current Implementation

The TypeScript FCC extension implements:

- `QUIETFILL / PRIVATE_BID`: decode the contract-authenticated envelope `(auctionId, bidder, ciphertext)`, decrypt the ECIES ciphertext, ABI-decode the private bid, reject any plaintext whose bidder or auction does not match the envelope, enforce monotonic bidder nonces, and store only the latest bid per bidder.
- `QUIETFILL / CLEAR`: select the highest bid inside the immutable on-chain floor/ceiling collar, with deterministic address tie-breaking.
- Price-free public receipts and state. Bid prices must never be exposed by `/state`, logs, or the bid receipt.

The Solidity contract in `contracts/InstructionSender.sol` implements:

- Seller FXRP escrow and dealer USDT0 ceiling escrow.
- One ceiling deposit per dealer, reused for encrypted replacement bids.
- Bid instructions wrap the ciphertext as `abi.encode(auctionId, msg.sender, encryptedBid)` so the TEE can bind every bid to its escrowed sender and auction.
- No owner and no admin functions: every entry point is permissionless.
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
7. The TEE only accepts a plaintext whose bidder and auction match the contract-authenticated instruction envelope, so no bidder can overwrite or displace another bidder's stored bid.
8. The TEE minimizes data: plaintext bids are purged the moment an auction clears, a re-delivered CLEAR instruction returns the cached byte-identical result (forgotten after a retention window), bids after a clear are rejected, and `/state` exposes no bid counts.

Contract tests live in `test/QuietFillAuction.t.sol`. They cover valid settlement, forged signatures, relayer tampering, replay, an unescrowed winner, no-fill, timeout recovery, late bids, replacement bids, registry-selected TEE pinning, and envelope binding.

The web app reads Flare's FTSOv2 XRP/USD feed on-chain (ContractRegistry → FtsoV2 over the public Coston2 RPC) as the reference rate beside CoinGecko, and sellers can set the collar at FTSO ±5% in one click.

The Go tooling in `tools/` deploys QuietFillAuction (with verified escrow-token addresses, or auto-deployed mintable TestTokens on a local devnet) and `run-test` drives one real auction end to end against a running FCC stack. The web app in `web/` (React + viem) is the seller/dealer product: it encrypts bids in the browser with a tee-node-compatible ECIES implementation (Go cross-check fixture committed in `web/src/lib/ecies.test.ts`), verifies the proxy TEE key against the auction's pinned teeId before encrypting, and relays the signed clear result into `settleAuction`.

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

Everything below assumes the codebase state after the tooling and web-app commits: bindings generate via `./scripts/generate-bindings.sh` (forge + jq + Go, or the Docker fallback in the script header of the same name), `tools/` deploys and drives QuietFillAuction end to end, and `web/` is the seller/dealer app with tee-node-compatible in-browser ECIES (cross-checked against the pinned revision in both directions).

### 1. Deploy to Coston2

- Resolve the **real** Coston2 FXRP and USDT0 addresses against official Flare sources — never invent them. Set `BASE_TOKEN` and `QUOTE_TOKEN` in `.env`; `deploy-contract` refuses to run on a live network without them and verifies code exists and `symbol()`/`decimals()` answer over RPC.
- Follow the Coston2 flow in [docs/scaffold-readme.md](docs/scaffold-readme.md): funded key in `.env`, `LOCAL_MODE=false`, proxy config with indexer credentials, then `./scripts/pre-build.sh`, `./scripts/start-services.sh --chain coston2`, ngrok on 6674, `./scripts/post-build.sh`.
- For the browser to reach the proxy, the tunnel must add CORS headers, e.g. `ngrok http 6674 --response-header-add "Access-Control-Allow-Origin: *"`.

### 2. Prove one live settlement with the runner

`./scripts/test.sh` runs `tools/cmd/run-test`: it encrypts a bid to the live TEE key, submits it, requests the clear, fetches the threshold-tagged TEE signature from the proxy, relays it into `settleAuction`, and asserts the settled state. Set `DEALER_PRIVATE_KEY` for a two-wallet run. Preserve the printed instruction IDs and settlement tx hash.

### 3. Ship the frontend and run the public demo

- `cd web && npm ci && npm run build`; deploy `web/dist/` to any static host. Users enter the contract address and proxy URL in the Connection panel (persisted in localStorage).
- Run a real multi-wallet auction with faucet FXRP/USDT0 and preserve transaction hashes, contract address, extension ID, TEE ID, proxy URL, and screenshots/video.
- Update the README Status section as pieces go live.

## Repository Provenance

The repository intentionally retains Flare Foundation's official `fce-extension-scaffold` history. `upstream` points to the Flare repository and `origin` points to `N-45div/Quietfill`. QuietFill-specific work starts at commit `d719b2e`. Keep a clear public "built during the hackathon" section rather than squashing away scaffold provenance.


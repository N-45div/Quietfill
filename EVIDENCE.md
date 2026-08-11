# Live on Coston2 — end-to-end evidence

A complete confidential auction ran on Flare's Coston2 testnet: encrypted bid →
TEE clearing → on-chain settlement verified against the TEE's chain-bound
signature. Nothing mocked. Captured 2026-08-11.

## Deployment

| Thing | Address / value |
|---|---|
| **QuietFillAuction** | [`0x155f065A741b1CBe2A57A5CE28A75a3727ffEbDD`](https://coston2-explorer.flare.network/address/0x155f065A741b1CBe2A57A5CE28A75a3727ffEbDD) |
| Extension ID | `66046` (registered on FlareTeeManager) |
| Pinned TEE | [`0xca6F10bD9bedeF9c9f4c873F64f886B4B3241726`](https://coston2-explorer.flare.network/address/0xca6F10bD9bedeF9c9f4c873F64f886B4B3241726) — status PRODUCTION |
| FCC proxy (public) | `https://quietfill-fcc.onrender.com/info` |
| Base token (FXRP) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Quote token (USDT0) | `0xC1A5B41512496B80903D1f32d6dEa3a73212E71F` |
| Chain | Coston2 (114) |

## The auction (id 6), transaction by transaction

| Step | Tx |
|---|---|
| Seller escrows FXRP + creates auction | [`0x06fc40f6…12fab9b`](https://coston2-explorer.flare.network/tx/0x06fc40f6294faee3abc81fd04c56ee0786ca6d63851b060d4158816c912fab9b) |
| Dealer escrows ceiling + submits **encrypted** bid | [`0x61daebdd…96ff2288a`](https://coston2-explorer.flare.network/tx/0x61daebdd4ea2ebdf2ba9dc53054407f8d1a0028e5f89f24d44b2b0696ff2288a) |
| Request clear (after bid deadline) | [`0xe28116ff…1147ec6`](https://coston2-explorer.flare.network/tx/0xe28116fffa24ea72879872df0a529f47133b458238c63e2b82a6487ea1147ec6) |
| **Settle** — TEE signature verified on-chain | [`0xb5ca617b…58a386092`](https://coston2-explorer.flare.network/tx/0xb5ca617b0701dd6b972179f2e2685b6a83c9f4126c2a4a24159072058a386092) |

FCC instruction IDs (delivered through the public proxy to the enclave):

- Bid: `0x2ee9bd87558f483ec3980edcc2ee847eb1d91d5fa76082e8fde2d11eeee5141d`
- Clear: `0x520e8fe65c9d47695b8bfb7657ef5bd84a5b172cd2288d8a3466004517dbbc60`

## What this proves

1. The dealer's bid was **ECIES-encrypted to the pinned TEE's key** (305-byte
   ciphertext) and only ciphertext went on-chain.
2. The TEE returned a **price-free receipt** (commitment
   `0x12293f30…`, no price) — the losing-quote privacy invariant, live.
3. The enclave **cleared inside the TEE** and produced the chain-bound
   `TEE_ACTION_RESULT` signature; the winner cleared at unit price
   `2.2` inside the collar `2.0–2.5`.
4. `settleAuction` **recovered the pinned TEE's address from the signature** and
   settled atomically — the browser and relayer never chose the winner.

Reproduce with `./scripts/test.sh` (or `tools/cmd/run-test`) against the live
proxy. See [deploy/render/README.md](deploy/render/README.md) for the operator
notes, including the TEE identity-rotation gotcha and the `pause()` step for
retiring a stale machine.

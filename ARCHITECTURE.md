# Architecture

How QuietFill is put together, end to end. The README explains what it does and
why; this explains how, and — more usefully — *where the trust actually sits*.

The whole design answers one question: **how can competing dealers submit
prices that nobody can read, and still have everyone agree on who won?** The
answer is that the winner is chosen inside a hardware enclave, and the contract
will only accept a result carrying that enclave's signature. No operator, no
relayer, and no admin key can substitute for it.

---

## 1. The pieces

```mermaid
flowchart TB
  subgraph browser["Browser (untrusted)"]
    UI["React + viem app<br/>encrypts the bid locally"]
  end

  subgraph chain["Flare Coston2"]
    QF["QuietFillAuction<br/>escrow, TEE pinning, settlement"]
    REG["FlareTeeManager<br/>extension + machine registry"]
    FTSO["FTSOv2 oracle<br/>XRP/USD reference rate"]
    TOK["FXRP and USDT0<br/>ERC-20 escrow assets"]
  end

  subgraph host["Hosted container (untrusted operator)"]
    EDGE["HTTPS edge<br/>CORS, single public port"]
    PROXY["tee-proxy<br/>instruction queue"]
    REDIS["redis"]
    subgraph enclave["Enclave boundary"]
      TEE["tee-node + QuietFill extension<br/>the only place plaintext bids exist"]
    end
  end

  DP["Flare data providers"]

  UI -->|"ciphertext + escrow tx"| QF
  UI -->|"reads rate"| FTSO
  UI -->|"polls results"| EDGE
  QF -->|"dispatch instruction"| REG
  REG -.->|"cosigned delivery"| DP
  DP -->|"POST /instruction"| EDGE
  EDGE --> PROXY
  PROXY <--> REDIS
  PROXY <-->|"queue + signed results"| TEE
  QF -->|"pin one machine"| REG
  QF <-->|"transfers"| TOK
```

The operator of that container is explicitly **not** trusted. They can see
ciphertext, restart processes, and drop traffic — but they cannot read a bid or
forge a settlement, because the decryption key never leaves the enclave and the
contract verifies a signature only the enclave can produce.

---

## 2. One auction, end to end

```mermaid
sequenceDiagram
  autonumber
  participant S as Seller
  participant D as Dealer browser
  participant C as QuietFillAuction
  participant R as Flare registry
  participant T as Enclave

  S->>C: createAuction(lot, floor, ceiling) + FXRP escrow
  C->>R: getRandomTeeIds(extensionId)
  R-->>C: one machine, pinned for this auction's lifetime

  D->>C: read auction, incl. pinned TEE
  D->>T: fetch TEE public key via proxy
  Note over D: refuses to encrypt unless the served key<br/>hashes to the pinned machine
  D->>D: ECIES-encrypt (bidder, auction, nonce, price, salt)
  D->>C: submitPrivateBid(id, ciphertext) + USDT0 ceiling escrow
  C->>T: abi.encode(auctionId, msg.sender, ciphertext)
  T->>T: decrypt, reject any plaintext that<br/>disagrees with the envelope
  T-->>D: price-free receipt (commitment only)

  S->>C: requestClear(auctionId) — permissionless, after deadline
  C->>T: (auctionId, contract, floor, ceiling)
  T->>T: highest eligible price wins,<br/>ties broken by lower address
  T-->>C: ClearResult + chain-bound signature (via any relayer)
  C->>C: recover signer, require == pinned TEE
  C->>S: quote proceeds
  C->>D: lot + refund of the spread
```

Two details in there carry most of the security weight:

**The envelope (step 11).** The contract wraps every bid as
`abi.encode(auctionId, msg.sender, ciphertext)`. `msg.sender` is authenticated
by the chain, so the enclave can reject a plaintext claiming to be someone
else's bid. Without this, any escrowed party could overwrite a rival's bid with
a spoofed one, or bind a ciphertext to an auction they never escrowed for.

**The pin (step 2).** The machine is chosen by the registry at creation and
frozen for that auction. Settlement recovers the signer and compares it to that
address, so a result from any other machine — including one the operator
registers later — is rejected.

---

## 3. What is secret, and for how long

```mermaid
flowchart LR
  P["Bid price<br/>plaintext"] -->|"ECIES in browser"| CT["Ciphertext<br/>on-chain"]
  CT -->|"decrypt inside enclave"| MEM["Enclave memory<br/>only readable place"]
  MEM -->|"auction clears"| PURGE["Purged"]
  MEM -->|"winner only"| CLEAR["Clearing price<br/>public at settlement"]

  style MEM stroke-dasharray: 4 4
```

- Losing prices are **never** published — not in events, receipts, `/state`, or
  logs — and are deleted from enclave memory the moment the auction clears.
- The winning price becomes public at settlement, because settlement has to move
  exactly that much money.
- `/state` reports no bid counts either, so bid flow is not observable by
  polling the proxy.

**What stays public, deliberately:** that you escrowed, and therefore that you
are participating. Escrow moves ERC-20s, and token transfers are visible on any
chain. QuietFill hides *prices and intent*, not *participation* — and
settlement remains fully auditable, which is the point.

---

## 4. Trust boundaries

| Component | Trusted for | Cannot |
|---|---|---|
| Browser app | Nothing | Read another bid, or influence the winner |
| Relayer | Nothing | Alter, replay, or forge a result |
| Container operator | Availability only | Decrypt a bid or settle an auction |
| Enclave | Clearing correctly | Move funds directly, or settle for another auction |
| Contract | Escrow and verification | Be upgraded, paused, or overridden — it has no owner |

The signature the contract checks is bound to the domain
`TEE_ACTION_RESULT`, `block.chainid`, the clear instruction id, and every field
of the result. A signature is therefore useless on another chain, another
auction, or with a single field altered.

---

## 5. When things break

Liveness is deliberately separated from safety: **no failure path can strand
funds.**

```mermaid
stateDiagram-v2
  [*] --> Open: createAuction
  Open --> ClearRequested: requestClear
  ClearRequested --> Settled: valid TEE signature
  ClearRequested --> NoFill: signed, no eligible bid
  Open --> Cancelled: settle deadline passes
  ClearRequested --> Cancelled: settle deadline passes

  Settled --> [*]
  NoFill --> [*]
  Cancelled --> [*]
```

- **Enclave never answers** → after the settle deadline anyone calls
  `cancelTimedOutAuction`; the seller's lot returns and dealers withdraw their
  escrow.
- **No bid inside the collar** → the enclave signs an explicit no-fill; the lot
  goes back.
- **Winner cannot pay** → impossible by construction, since a full ceiling
  escrow is a precondition for winning.

This is demonstrated on-chain rather than asserted — see EVIDENCE.md, where an
auction pinned to a machine that was retired before it could clear returned the
seller's escrow in full.

**The known cost of this design:** pinning one machine per auction means a host
restart, which mints a new enclave identity, strands that auction until its
timeout. Verifying against the *currently active* set at settlement instead
would remove the coupling without weakening the signature check, and is the
main change worth making next.

---

## 6. Repository map

| Path | Role |
|---|---|
| `contracts/InstructionSender.sol` | `QuietFillAuction` — escrow, pinning, signature verification, settlement |
| `typescript/src/app/` | The enclave extension: envelope checks, decryption, clearing |
| `typescript/src/base/` | Wire framework fixed by the FCC container contract |
| `web/` | Seller and dealer app; in-browser ECIES, TEE-key verification, relay |
| `tools/` | Go tooling: deploy, register, and a runner that drives a full auction |
| `deploy/render/` | Single-container deployment of the whole stack |
| `scripts/` | Lifecycle: build, register, health-check, and re-register |

The browser's ECIES is byte-compatible with the enclave's Go implementation;
that equivalence is pinned by a committed fixture so a library change cannot
silently break decryption.

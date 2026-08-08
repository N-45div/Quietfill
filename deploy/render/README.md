# Deploying QuietFill on Render — free tier, no card

The whole stack runs free: the FCC backend (redis + tee-proxy + tee-node +
extension + CORS edge) as **one Docker web service**, and the app as a
**static site**. [render.yaml](../../render.yaml) declares both.

The free instance sleeps after 15 idle minutes; the
[keep-alive workflow](../../.github/workflows/keepalive.yml) pings it every
10 minutes so it never does. 750 free instance-hours/month cover exactly one
always-awake service.

## What you need (all free)

| Thing | Where |
|---|---|
| Coston2 keys (deployer + proxy), funded with C2FLR | [faucet.flare.network/coston2](https://faucet.flare.network/coston2) |
| Indexer DB credentials for the proxy | Pinned message in the hackathon channel (user `hackathon_user_57`; host/name are prefilled in `render.yaml`). The indexer-reader creds in old docs are dead. |
| Real Coston2 FXRP + USDT0 addresses | Official Flare sources — `deploy-contract` verifies them |
| Render account | [render.com](https://render.com) — free, no card |
| Go 1.25+, jq, Foundry on your machine | `winget install GoLang.Go jqlang.jq` — for the one-time on-chain steps |

## 1 — Deploy the contract (from your machine)

```bash
# .env at repo root:
#   DEPLOYMENT_PRIVATE_KEY=<funded key>   INITIAL_OWNER=<its address>
#   BASE_TOKEN=<FXRP addr>  QUOTE_TOKEN=<USDT0 addr>
#   LOCAL_MODE=false  CHAIN=coston2
#   CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc
#   ADDRESSES_FILE=./config/coston2/deployed-addresses.json
./scripts/pre-build.sh
```

This deploys `QuietFillAuction`, registers the extension, and writes
`EXTENSION_ID` + `INSTRUCTION_SENDER` into `config/extension.env`. Keep both.

## 2 — Create the Render services

Dashboard → **New → Blueprint** → pick this repo. Render reads `render.yaml`
and creates `quietfill-fcc` (Docker, free) and `quietfill-web` (static, free).

Fill the secret env vars on **quietfill-fcc**:

| Var | Value |
|---|---|
| `PROXY_PRIVATE_KEY` | funded Coston2 key (proxy signing) |
| `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | indexer credentials from Flare |
| `EXTENSION_ID` | from step 1 |
| `INITIAL_OWNER` | deployer address |

Deploy. First build takes ~10–15 min (it compiles tee-node and tee-proxy from
the pinned revisions). When it's up, `https://quietfill-fcc.onrender.com/info`
must return JSON — that URL is your public FCC proxy.

## 3 — Register the TEE (from your machine)

```bash
# add to .env:
#   EXT_PROXY_URL=https://quietfill-fcc.onrender.com
#   NORMAL_PROXY_URL=https://tee-proxy-coston2-1.flare.rocks
./scripts/post-build.sh
```

The container configures the TEE from env, so there is no localhost config
step. If any script step tries to reach `localhost:5501`, skip it and run the
three registration commands individually (`allow-tee-version`,
`set-governance` via post-build, `register-tee` **without** `-l`) — see the
root README's "Running Individual Steps".

## 4 — Keep it awake

Repo → Settings → Secrets and variables → Actions → **Variables** → add
`PROXY_URL = https://quietfill-fcc.onrender.com`. The scheduled workflow does
the rest. (Alternative: a free UptimeRobot monitor on `/info`.)

## 5 — Point the app at it

Open the `quietfill-web` URL, paste the contract address and
`https://quietfill-fcc.onrender.com` into the Connection panel, and run an
auction with MetaMask on Coston2. Or drive one end-to-end from the CLI:

```bash
EXT_PROXY_URL=https://quietfill-fcc.onrender.com ./scripts/test.sh
```

## Coston2 FCC redeploy notes (July 2026)

Coston2 FCC was redeployed; most register-tee failures in the wild are stale
stacks talking to the dead deployment.

- The **live FlareTeeManager is `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`**
  — `config/coston2/deployed-addresses.json` in this repo already carries it.
  If you see `FunctionNotFound` or "only reward offers manager", something is
  still pointed at the old `0x004224fa…5d41F`.
- Registrations from before the redeploy are gone: run `pre-build.sh` for a
  fresh `EXTENSION_ID` before anything else.
- `post-build.sh` now registers with `-command rRap` (capital R = fresh
  challenge) by default — also the right call after any TEE identity rotation.
- tee-node **v0.0.22+** is mandatory on the network; this repo pins v0.0.23
  paired with the matching tee-proxy commit.
- Check your machine's state yourself in 30 seconds:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachine(address)((address,address,string))" <teeId>   # URL on-chain = URL you serve?
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" <teeId>                # 1 INITIALIZED, 2 PRODUCTION
```

- A registered URL must be **stable** — quick tunnels rot on restart and leave
  machines stuck at INITIALIZED. The Render URL never changes, which is half
  the reason this deployment exists.
- `SIMULATED_TEE=true` on Coston2 is fine for judging (confirmed by the
  organizers); GCP Confidential Space is not required.

## Free-tier realities

- **Cold starts:** if the pinger lapses, the first request takes ~1 min. Open
  the app a couple of minutes before any live demo.
- **512 MB / 0.1 CPU:** fits this stack (~300 MB) and demo load fine; it is
  not a production SLA.
- **Restarts lose in-flight bids:** the TEE keeps bids in memory by design,
  so a redeploy mid-auction means that auction no-fills or times out (funds
  are always recoverable — that's invariant 5). Keep demo auctions short.
- **Attestation is simulated** (`SIMULATED_TEE=true`) — the scaffold's
  standard Coston2 dev mode. Real hardware attestation requires a GCP
  Confidential VM and is out of scope for a free deployment.

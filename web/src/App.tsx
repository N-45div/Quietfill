import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address, type Chain } from "viem";

import { AuctionPanel } from "./components/AuctionPanel";
import { SellerPanel } from "./components/SellerPanel";
import { chainById, connectWallet, injectedProvider, publicClientFor, walletClientFor } from "./lib/wallet";

export interface AppContext {
  account: Address;
  chain: Chain;
  contract: Address;
  proxyUrl: string;
  publicClient: ReturnType<typeof publicClientFor>;
  walletClient: ReturnType<typeof walletClientFor>;
  log: (message: string, kind?: "info" | "ok" | "err", href?: string) => void;
}

interface LogLine {
  at: string;
  message: string;
  kind: "info" | "ok" | "err";
  href?: string;
}

const stored = (key: string, fallback = "") => localStorage.getItem(key) ?? fallback;

export function App() {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [contract, setContract] = useState(stored("quietfill.contract"));
  const [proxyUrl, setProxyUrl] = useState(stored("quietfill.proxy", "/fcc"));
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState("");

  useEffect(() => localStorage.setItem("quietfill.contract", contract), [contract]);
  useEffect(() => localStorage.setItem("quietfill.proxy", proxyUrl), [proxyUrl]);

  useEffect(() => {
    const provider = injectedProvider();
    provider?.on?.("accountsChanged", (accounts) => {
      const list = accounts as Address[];
      setAccount(list[0] ?? null);
    });
    provider?.on?.("chainChanged", (id) => setChainId(Number(id as string)));
  }, []);

  const log = useCallback((message: string, kind: "info" | "ok" | "err" = "info", href?: string) => {
    const at = new Date().toLocaleTimeString();
    setLines((prev) => [...prev.slice(-120), { at, message, kind, href }]);
  }, []);

  const connect = async () => {
    setError("");
    try {
      const { account: acct, chainId: id } = await connectWallet();
      setAccount(acct);
      setChainId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const chain = chainId != null ? chainById(chainId) : undefined;
  const ready = account && chain && isAddress(contract);

  const ctx = useMemo<AppContext | null>(() => {
    if (!ready || !account || !chain) return null;
    return {
      account,
      chain,
      contract: contract as Address,
      proxyUrl: proxyUrl.replace(/\/$/, ""),
      publicClient: publicClientFor(chain),
      walletClient: walletClientFor(chain, account),
      log,
    };
  }, [ready, account, chain, contract, proxyUrl, log]);

  return (
    <div className="page">
      <div className="glow" />
      <header className="navwrap">
        <nav className="top">
          <a className="brand" href="#top">
            Quiet<em>Fill</em>
          </a>
          <div className="links">
            <a href="#how">How it works</a>
            <a href="#security">Security</a>
            <a href="#app">App</a>
            <a href="https://github.com/N-45div/Quietfill" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
          <div className="wallet">
            {account ? (
              <>
                <b>●</b> {account.slice(0, 6)}…{account.slice(-4)}
                {chain ? ` · ${chain.name}` : chainId != null ? ` · unsupported chain ${chainId}` : ""}
              </>
            ) : (
              <button className="secondary" style={{ margin: 0 }} onClick={connect}>
                Connect wallet
              </button>
            )}
          </div>
        </nav>
      </header>
      <div className="shell">
        <section className="hero" id="top">
          <div>
            <span className="badge">
              <i /> Flare Confidential Compute · sealed-bid RFQ
            </span>
            <h1>
              Sell size.
              <br />
              <span className="grad">Show nothing.</span>
            </h1>
            <p className="sub">
              QuietFill auctions a fixed lot of <b>FXRP</b> to competing dealers whose bids are{" "}
              <b>encrypted in the browser</b> and opened only inside a hardware enclave on Flare.
              Losing quotes stay secret forever — the contract settles solely on the{" "}
              <b>TEE&apos;s chain-bound signature</b>. No order book leakage, no trusted broker,
              no admin keys.
            </p>
            <div className="cta">
              {!account && (
                <button onClick={connect} style={{ margin: 0 }}>
                  Connect wallet
                </button>
              )}
              <a href="#how">
                <button className="secondary" style={{ margin: 0 }}>
                  How it works
                </button>
              </a>
            </div>
            {error && <p className="notice">{error}</p>}
            {!account && !injectedProvider() && (
              <p className="notice">No wallet found — install MetaMask or another EIP-1193 wallet.</p>
            )}
            {account && chainId != null && !chain && (
              <p className="notice">Switch your wallet to Coston2 (chain 114) or a local devnet (31337).</p>
            )}
          </div>

          <div className="ticket" aria-hidden>
            <div className="t-head">
              <h3>Auction #7 · 5,000 FXRP</h3>
              <span className="status ClearRequested">Clearing</span>
            </div>
            <p className="t-sub mono">collar 2.00 – 2.50 USDT0 · 4 sealed bids</p>
            <div className="bidrow">
              <span className="who mono">0x93aF…D471</span>
              <span className="price mono">2.31 USDT0</span>
            </div>
            <div className="bidrow winner">
              <span className="who mono">0x51C2…09eB · winner</span>
              <span className="price mono">2.41 USDT0</span>
            </div>
            <div className="bidrow">
              <span className="who mono">0xB7d0…33Aa</span>
              <span className="price mono">2.18 USDT0</span>
            </div>
            <div className="bidrow">
              <span className="who mono">0x04eD…9C55</span>
              <span className="price mono">2.07 USDT0</span>
            </div>
            <div className="t-foot mono">
              <span>losing bids: encrypted forever</span>
              <span className="sig">✓ TEE signature verified</span>
            </div>
          </div>
        </section>

        <section className="block" id="how">
          <h2>How it works</h2>
          <p className="lead">
            One auction, four moves. The website and the relayer are untrusted throughout — the only
            authority is the TEE pinned to the auction from Flare&apos;s on-chain machine registry.
          </p>
          <div className="steps">
            <div className="step">
              <span className="n">1</span>
              <h3>Seller escrows the lot</h3>
              <p>
                The FXRP lot and a public floor/ceiling collar go on-chain. The contract pins one
                registry-selected TEE to the auction.
              </p>
            </div>
            <div className="step">
              <span className="n">2</span>
              <h3>Dealers bid in secret</h3>
              <p>
                Each dealer escrows the public worst case once, then encrypts their real price to
                the TEE&apos;s key — right in the browser.
              </p>
            </div>
            <div className="step">
              <span className="n">3</span>
              <h3>The enclave clears</h3>
              <p>
                After the deadline anyone requests the clear. The TEE decrypts inside hardware,
                picks the best eligible price, and signs the result.
              </p>
            </div>
            <div className="step">
              <span className="n">4</span>
              <h3>The contract settles</h3>
              <p>
                Anyone relays the signed result. The contract verifies the exact chain-bound TEE
                signature and atomically pays seller, winner, and refunds.
              </p>
            </div>
          </div>
        </section>

        <section className="block" id="security">
          <h2>What keeps it honest</h2>
          <div className="tiles">
            <div className="tile">
              <b>Losing quotes never leak</b>
              Prices exist in plaintext only inside the enclave. Receipts, events, and state are
              price-free.
            </div>
            <div className="tile">
              <b>Nobody picks the winner</b>
              Settlement requires the pinned TEE&apos;s signature over every result field — relayers
              can&apos;t tamper, replay, or forge.
            </div>
            <div className="tile">
              <b>No admin keys</b>
              No owner, no upgrades, no settable signer. Every function — selling, bidding,
              settling, refunds — is permissionless.
            </div>
            <div className="tile">
              <b>Funds always come back</b>
              Escrow up front, and every ending — settled, no-fill, timeout — has a permissionless
              path that returns everyone&apos;s tokens.
            </div>
          </div>
        </section>

        <section className="block" id="app">
          <h2>Trade</h2>
          <p className="lead">
            {ctx
              ? "You're connected — everything below is live on-chain."
              : "Connect a wallet, paste the contract address and proxy URL, and the panels go live."}
          </p>
          <div className="grid">
            <section className="panel wide">
              <h2>Connection</h2>
              <p className="hint">
                Everything is permissionless — any wallet can sell, bid, clear, or relay a
                settlement.
              </p>
              <div className="row">
                <div>
                  <label>QuietFillAuction contract</label>
                  <input
                    value={contract}
                    onChange={(e) => setContract(e.target.value.trim())}
                    placeholder="0x…"
                  />
                </div>
                <div>
                  <label>Extension proxy URL (/fcc proxies in dev)</label>
                  <input
                    value={proxyUrl}
                    onChange={(e) => setProxyUrl(e.target.value.trim())}
                    placeholder="https://your-proxy.example"
                  />
                </div>
              </div>
            </section>

            {ctx ? (
              <>
                <SellerPanel ctx={ctx} />
                <AuctionPanel ctx={ctx} />
                <section className="panel wide">
                  <h2>Activity</h2>
                  <div className="log">
                    {lines.length === 0 && <p>No activity yet.</p>}
                    {lines.map((l, i) => (
                      <p key={i} className={l.kind === "info" ? undefined : l.kind}>
                        [{l.at}] {l.message}
                        {l.href && (
                          <>
                            {" "}
                            <a href={l.href} target="_blank" rel="noreferrer">
                              explorer ↗
                            </a>
                          </>
                        )}
                      </p>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <>
                <section className="panel preview">
                  <h2>Sell a lot</h2>
                  <p className="hint">
                    Escrow the FXRP lot, set the collar, pick the bid window. One registry-selected
                    TEE gets pinned to your auction.
                  </p>
                  <div className="row">
                    <div>
                      <label>Lot size (base tokens)</label>
                      <input disabled value="5000" />
                    </div>
                    <div>
                      <label>Bid window (minutes)</label>
                      <input disabled value="10" />
                    </div>
                  </div>
                  <div className="row">
                    <div>
                      <label>Floor price</label>
                      <input disabled value="2.0" />
                    </div>
                    <div>
                      <label>Ceiling price</label>
                      <input disabled value="2.5" />
                    </div>
                  </div>
                  <button disabled>Escrow lot &amp; create auction</button>
                </section>
                <section className="panel preview">
                  <h2>Bid on an auction</h2>
                  <p className="hint">
                    Your price is encrypted to the auction&apos;s TEE before it ever leaves the tab —
                    the chain, the seller, and other dealers only see ciphertext.
                  </p>
                  <div className="row">
                    <div>
                      <label>Auction ID</label>
                      <input disabled value="7" />
                    </div>
                    <div>
                      <label>Your bid (stays private)</label>
                      <input disabled value="2.41" />
                    </div>
                  </div>
                  <dl className="facts">
                    <dt>State</dt>
                    <dd>
                      <span className="status Open">Open</span>
                    </dd>
                    <dt>Collar</dt>
                    <dd>2.00 – 2.50</dd>
                    <dt>Pinned TEE</dt>
                    <dd>0x8A21…f4E3</dd>
                  </dl>
                  <button disabled>Escrow ceiling &amp; bid</button>
                </section>
              </>
            )}
          </div>
        </section>

        <footer className="foot">
          <span>
            Built for Flare&apos;s Summer Signal hackathon on DoraHacks — on the official FCC
            extension scaffold.
          </span>
          <span>
            <a href="https://github.com/N-45div/Quietfill" target="_blank" rel="noreferrer">
              Source &amp; provenance ↗
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

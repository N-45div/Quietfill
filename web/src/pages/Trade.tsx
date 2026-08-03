import type { AppContext } from "../App";
import { AuctionPanel } from "../components/AuctionPanel";
import { MarketChart } from "../components/MarketChart";
import { SellerPanel } from "../components/SellerPanel";

export interface LogLine {
  at: string;
  message: string;
  kind: "info" | "ok" | "err";
  href?: string;
}

interface TradeProps {
  ctx: AppContext | null;
  lines: LogLine[];
  contract: string;
  setContract: (v: string) => void;
  proxyUrl: string;
  setProxyUrl: (v: string) => void;
  walletNotice: string;
  onConnect: () => void;
  connected: boolean;
}

/** The app: live market rate, connection, seller & dealer panels, activity. */
export function Trade({
  ctx,
  lines,
  contract,
  setContract,
  proxyUrl,
  setProxyUrl,
  walletNotice,
  onConnect,
  connected,
}: TradeProps) {
  return (
    <section className="block trade">
      <div className="trade-head">
        <div>
          <h2>Trade</h2>
          <p className="lead" style={{ margin: 0 }}>
            {ctx
              ? "Connected — everything below is live on-chain."
              : "Connect a wallet and paste the contract + proxy to go live."}
          </p>
        </div>
        {!connected && (
          <button style={{ margin: 0 }} onClick={onConnect}>
            Connect wallet
          </button>
        )}
      </div>
      {walletNotice && <p className="notice">{walletNotice}</p>}

      <div className="grid">
        <MarketChart />

        <section className="panel wide">
          <h2>Connection</h2>
          <p className="hint">
            Everything is permissionless — any wallet can sell, bid, clear, or relay a settlement.
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
                Escrow the FXRP lot, set the collar, pick the bid window. One registry-selected TEE
                gets pinned to your auction.
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
  );
}

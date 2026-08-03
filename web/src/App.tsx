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
    <div className="shell">
      <header className="top">
        <h1>
          Quiet<span>Fill</span>
        </h1>
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
      </header>
      <p className="tagline">
        Sealed-bid FXRP/USDT0 auctions — bids encrypted to a Flare Confidential Compute TEE,
        settlement verified on-chain against its signature.
      </p>
      {error && <p className="notice">{error}</p>}
      {account && chainId != null && !chain && (
        <p className="notice">Switch your wallet to Coston2 (chain 114) or a local devnet (31337).</p>
      )}

      <div className="grid">
        <section className="panel wide">
          <h2>Connection</h2>
          <p className="hint">
            Everything below is permissionless — any wallet can sell, bid, clear, or relay a settlement.
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

        {ctx && (
          <>
            <SellerPanel ctx={ctx} />
            <AuctionPanel ctx={ctx} />
          </>
        )}

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
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address, type Chain } from "viem";

import { Home } from "./pages/Home";
import { Trade, type LogLine } from "./pages/Trade";
import { useRoute } from "./lib/router";
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

const stored = (key: string, fallback = "") => localStorage.getItem(key) ?? fallback;

export function App() {
  const route = useRoute();
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

  let walletNotice = "";
  if (error) walletNotice = error;
  else if (!account && !injectedProvider())
    walletNotice = "No wallet found — install MetaMask or another EIP-1193 wallet.";
  else if (account && chainId != null && !chain)
    walletNotice = "Switch your wallet to Coston2 (chain 114) or a local devnet (31337).";

  return (
    <div className="page">
      <div className="glow" />
      <header className="navwrap">
        <nav className="top">
          <a className="brand" href="#/">
            Quiet<em>Fill</em>
          </a>
          <div className="links">
            <a href="#/how">How it works</a>
            <a href="#/security">Security</a>
            <a href="#/trade">Trade</a>
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
            ) : route.page === "trade" ? (
              <button className="secondary" style={{ margin: 0 }} onClick={connect}>
                Connect wallet
              </button>
            ) : (
              <a href="#/trade">
                <button style={{ margin: 0 }}>Launch app</button>
              </a>
            )}
          </div>
        </nav>
      </header>
      <div className="shell">
        {route.page === "home" ? (
          <Home walletNotice={error} />
        ) : (
          <Trade
            ctx={ctx}
            lines={lines}
            contract={contract}
            setContract={setContract}
            proxyUrl={proxyUrl}
            setProxyUrl={setProxyUrl}
            walletNotice={walletNotice}
            onConnect={connect}
            connected={!!account}
          />
        )}

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

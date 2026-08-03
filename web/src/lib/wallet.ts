/** Thin viem wallet layer: injected provider, Coston2 + local devnet. */

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";

export const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
});

export const localDevnet = defineChain({
  id: 31337,
  name: "Local devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const CHAINS: Chain[] = [coston2, localDevnet];

export function chainById(id: number): Chain | undefined {
  return CHAINS.find((c) => c.id === id);
}

export function explorerTxUrl(chain: Chain | undefined, hash: string): string | null {
  const base = chain?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

export function injectedProvider(): Eip1193Provider | null {
  const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

export async function connectWallet(): Promise<{ account: Address; chainId: number }> {
  const provider = injectedProvider();
  if (!provider) throw new Error("No wallet found — install MetaMask or another EIP-1193 wallet");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts.length) throw new Error("Wallet returned no accounts");
  const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
  return { account: accounts[0], chainId: Number(chainHex) };
}

export function publicClientFor(chain: Chain): PublicClient {
  const provider = injectedProvider();
  return createPublicClient({
    chain,
    transport: provider ? custom(provider) : http(),
  });
}

export function walletClientFor(chain: Chain, account: Address): WalletClient {
  const provider = injectedProvider();
  if (!provider) throw new Error("No wallet available");
  return createWalletClient({ chain, account, transport: custom(provider) });
}

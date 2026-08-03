/**
 * Flare FTSOv2 — the network's own price oracle. The XRP/USD feed is the
 * on-chain reference rate FXRP collars should be priced against. Read over
 * the public Coston2 RPC, resolved through Flare's ContractRegistry (same
 * address on every Flare network).
 */

import { createPublicClient, http, parseAbi } from "viem";

import { coston2 } from "./wallet";

const CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;
// bytes21 feed id: 0x01 (category "crypto") + ascii "XRP/USD" + zero padding.
const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000" as const;

const registryAbi = parseAbi([
  "function getContractAddressByName(string _name) view returns (address)",
]);

const ftsoAbi = parseAbi([
  "function getFeedById(bytes21 _feedId) view returns (uint256 _value, int8 _decimals, uint64 _timestamp)",
]);

export interface FtsoRate {
  price: number;
  timestamp: number;
}

const client = createPublicClient({ chain: coston2, transport: http() });
let ftsoAddress: `0x${string}` | null = null;

export async function fetchFtsoXrpUsd(): Promise<FtsoRate> {
  ftsoAddress ??= await client.readContract({
    address: CONTRACT_REGISTRY,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["FtsoV2"],
  });
  const [value, decimals, timestamp] = await client.readContract({
    address: ftsoAddress,
    abi: ftsoAbi,
    functionName: "getFeedById",
    args: [XRP_USD_FEED_ID],
  });
  return {
    price: Number(value) / 10 ** Number(decimals),
    timestamp: Number(timestamp),
  };
}

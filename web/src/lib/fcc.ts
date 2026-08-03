/**
 * Client for the QuietFill extension proxy (tee-proxy external API) plus the
 * wire codecs shared with the TEE extension. Field shapes mirror tee-node's
 * pkg/types — do not rename fields.
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

export interface TeeInfoResponse {
  teeInfo: {
    publicKey: { x: Hex; y: Hex };
    chainId: number;
  };
}

export interface ActionResult {
  id: Hex;
  submissionTag: string;
  status: number; // 0 failed, 1 ok, 2 pending
  log: string;
  opType: Hex;
  opCommand: Hex;
  version: string;
  data: Hex;
}

export interface ActionResponse {
  result: ActionResult;
  signature: Hex;
  proxySignature: Hex;
}

/** The result tag whose TEE signature the contract verifies. */
export const THRESHOLD_TAG = "threshold";

const PRIVATE_BID_PARAMS = parseAbiParameters(
  "(address bidder, address contractAddr, uint256 auctionId, uint64 nonce, uint256 unitPriceWei, bytes32 salt)",
);

const BID_RECEIPT_PARAMS = parseAbiParameters(
  "address contractAddr, uint256 auctionId, address bidder, uint64 nonce, bytes32 bidCommitment",
);

const CLEAR_RESULT_PARAMS = parseAbiParameters(
  "address contractAddr, uint256 auctionId, address winner, uint256 unitPriceWei, uint64 winningNonce, bytes32 winningCommitment, uint256 submittedBidCount, uint256 eligibleBidCount",
);

export interface PrivateBid {
  bidder: Address;
  contractAddr: Address;
  auctionId: bigint;
  nonce: bigint;
  unitPriceWei: bigint;
  salt: Hex;
}

export interface ClearResult {
  contractAddr: Address;
  auctionId: bigint;
  winner: Address;
  unitPriceWei: bigint;
  winningNonce: bigint;
  winningCommitment: Hex;
  submittedBidCount: bigint;
  eligibleBidCount: bigint;
}

export function encodePrivateBid(bid: PrivateBid): Hex {
  return encodeAbiParameters(PRIVATE_BID_PARAMS, [bid]);
}

export function decodeBidReceipt(data: Hex) {
  const [contractAddr, auctionId, bidder, nonce, bidCommitment] =
    decodeAbiParameters(BID_RECEIPT_PARAMS, data);
  return { contractAddr, auctionId, bidder, nonce, bidCommitment };
}

export function decodeClearResult(data: Hex): ClearResult {
  const [
    contractAddr,
    auctionId,
    winner,
    unitPriceWei,
    winningNonce,
    winningCommitment,
    submittedBidCount,
    eligibleBidCount,
  ] = decodeAbiParameters(CLEAR_RESULT_PARAMS, data);
  return {
    contractAddr,
    auctionId,
    winner,
    unitPriceWei,
    winningNonce,
    winningCommitment,
    submittedBidCount,
    eligibleBidCount,
  };
}

/** Uncompressed SEC1 bytes (0x04 || X || Y) for the TEE public key. */
export function teePublicKeyBytes(key: { x: Hex; y: Hex }): Uint8Array {
  const strip = (h: Hex) => h.slice(2).padStart(64, "0");
  const hex = `04${strip(key.x)}${strip(key.y)}`;
  const out = new Uint8Array(65);
  for (let i = 0; i < 65; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The TEE's on-chain identity: keccak of the raw public key, last 20 bytes. */
export function teeIdFromPublicKey(key: { x: Hex; y: Hex }): Address {
  const strip = (h: Hex) => h.slice(2).padStart(64, "0");
  const hash = keccak256(`0x${strip(key.x)}${strip(key.y)}`);
  return getAddress(`0x${hash.slice(-40)}`);
}

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

export async function fetchTeeInfo(proxyUrl: string): Promise<TeeInfoResponse> {
  return (await get(`${proxyUrl}/info`)) as TeeInfoResponse;
}

/** Returns null while the proxy has no result yet. */
export async function fetchActionResponse(
  proxyUrl: string,
  instructionId: Hex,
): Promise<ActionResponse | null> {
  try {
    const resp = (await get(
      `${proxyUrl}/action/result/${instructionId}`,
    )) as ActionResponse;
    return resp?.result ? resp : null;
  } catch {
    return null;
  }
}

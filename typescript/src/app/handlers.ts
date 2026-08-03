import {
  getAddress,
  keccak256,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import { NodeClient } from "../base/node.js";
import type { Framework, HandlerResult } from "../base/types.js";
import {
  decodeClearMessage,
  decodePrivateBid,
  encodeBidReceipt,
  encodeClearResult,
  type PrivateBid,
} from "./abi.js";
import {
  OP_COMMAND_CLEAR,
  OP_COMMAND_PRIVATE_BID,
  OP_TYPE_QUIETFILL,
} from "./config.js";

interface Decryptor {
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

interface StoredBid extends PrivateBid {
  commitment: Hex;
}

const auctions = new Map<string, Map<string, StoredBid>>();
let decryptor: Decryptor = new NodeClient(process.env.SIGN_PORT ?? "9090");

export function setDecryptorForTests(next: Decryptor): void {
  decryptor = next;
}

export function resetState(): void {
  auctions.clear();
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_QUIETFILL, OP_COMMAND_PRIVATE_BID, handlePrivateBid);
  framework.handle(OP_TYPE_QUIETFILL, OP_COMMAND_CLEAR, handleClear);
}

export function reportState(): unknown {
  let privateBidCount = 0;
  for (const bids of auctions.values()) privateBidCount += bids.size;
  return {
    auctionsTracked: auctions.size,
    privateBidCount,
    pricesExposed: false,
  };
}

export async function handlePrivateBid(ciphertextHex: string): Promise<HandlerResult> {
  let ciphertext: Uint8Array;
  try {
    ciphertext = hexToBytes(ciphertextHex);
  } catch (error) {
    return failure(`invalid ciphertext: ${errorMessage(error)}`);
  }
  if (ciphertext.length === 0) return failure("ciphertext must not be empty");

  let plaintext: Uint8Array;
  try {
    plaintext = await decryptor.decrypt(ciphertext);
  } catch (error) {
    return failure(`decryption failed: ${errorMessage(error)}`);
  }

  let bid: PrivateBid;
  try {
    bid = decodePrivateBid(bytesToHex(plaintext) as Hex);
  } catch (error) {
    return failure(`decoding private bid: ${errorMessage(error)}`);
  }

  const validationError = validateBid(bid);
  if (validationError) return failure(validationError);

  const auctionKey = keyForAuction(bid.contractAddr, bid.auctionId);
  const bidderKey = bid.bidder.toLowerCase();
  const bids = auctions.get(auctionKey) ?? new Map<string, StoredBid>();
  const previous = bids.get(bidderKey);
  if (previous && bid.nonce <= previous.nonce) {
    return failure("bid nonce must increase");
  }

  const commitment = keccak256(bytesToHex(plaintext) as Hex);
  bids.set(bidderKey, { ...bid, commitment });
  auctions.set(auctionKey, bids);

  return success(
    encodeBidReceipt(
      bid.contractAddr,
      bid.auctionId,
      bid.bidder,
      bid.nonce,
      commitment,
    ),
  );
}

export function handleClear(messageHex: string): HandlerResult {
  let message;
  try {
    message = decodeClearMessage(messageHex as Hex);
  } catch (error) {
    return failure(`decoding clear request: ${errorMessage(error)}`);
  }

  if (message.auctionId <= 0n) return failure("auctionId must be positive");
  if (message.contractAddr === zeroAddress) return failure("contractAddr must not be zero");
  if (message.floorPriceWei <= 0n) return failure("floor price must be positive");
  if (message.ceilingPriceWei < message.floorPriceWei) {
    return failure("ceiling price must be at least floor price");
  }

  const bids = auctions.get(keyForAuction(message.contractAddr, message.auctionId));
  const submitted = bids?.size ?? 0;
  const eligible = [...(bids?.values() ?? [])].filter(
    (bid) =>
      bid.unitPriceWei >= message.floorPriceWei &&
      bid.unitPriceWei <= message.ceilingPriceWei,
  );

  eligible.sort((left, right) => {
    if (left.unitPriceWei > right.unitPriceWei) return -1;
    if (left.unitPriceWei < right.unitPriceWei) return 1;
    return left.bidder.toLowerCase().localeCompare(right.bidder.toLowerCase());
  });

  const winner = eligible[0];
  return success(
    encodeClearResult({
      contractAddr: message.contractAddr,
      auctionId: message.auctionId,
      winner: winner?.bidder ?? zeroAddress,
      unitPriceWei: winner?.unitPriceWei ?? 0n,
      winningNonce: winner?.nonce ?? 0n,
      winningCommitment: winner?.commitment ?? zeroHash,
      submittedBidCount: BigInt(submitted),
      eligibleBidCount: BigInt(eligible.length),
    }),
  );
}

function validateBid(bid: PrivateBid): string | null {
  try {
    bid.bidder = getAddress(bid.bidder);
    bid.contractAddr = getAddress(bid.contractAddr);
  } catch (error) {
    return `invalid address: ${errorMessage(error)}`;
  }
  if (bid.bidder === zeroAddress) return "bidder must not be zero";
  if (bid.contractAddr === zeroAddress) return "contractAddr must not be zero";
  if (bid.auctionId <= 0n) return "auctionId must be positive";
  if (bid.nonce <= 0n) return "nonce must be positive";
  if (bid.unitPriceWei <= 0n) return "unit price must be positive";
  if (bid.salt === zeroHash) return "salt must not be zero";
  return null;
}

function keyForAuction(contractAddr: Address, auctionId: bigint): string {
  return `${contractAddr.toLowerCase()}:${auctionId}`;
}

function success(data: Hex): HandlerResult {
  return [data, 1, null];
}

function failure(message: string): HandlerResult {
  return [null, 0, message];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

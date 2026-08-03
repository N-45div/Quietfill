import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

const PRIVATE_BID_PARAMS = parseAbiParameters(
  "(address bidder, address contractAddr, uint256 auctionId, uint64 nonce, uint256 unitPriceWei, bytes32 salt)",
);

const CLEAR_MESSAGE_PARAMS = parseAbiParameters(
  "(uint256 auctionId, address contractAddr, uint256 floorPriceWei, uint256 ceilingPriceWei)",
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

export interface ClearMessage {
  auctionId: bigint;
  contractAddr: Address;
  floorPriceWei: bigint;
  ceilingPriceWei: bigint;
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

export function decodePrivateBid(data: Hex): PrivateBid {
  const [bid] = decodeAbiParameters(PRIVATE_BID_PARAMS, data);
  return bid;
}

export function encodeClearMessage(message: ClearMessage): Hex {
  return encodeAbiParameters(CLEAR_MESSAGE_PARAMS, [message]);
}

export function decodeClearMessage(data: Hex): ClearMessage {
  const [message] = decodeAbiParameters(CLEAR_MESSAGE_PARAMS, data);
  return message;
}

export function encodeBidReceipt(
  contractAddr: Address,
  auctionId: bigint,
  bidder: Address,
  nonce: bigint,
  bidCommitment: Hex,
): Hex {
  return encodeAbiParameters(BID_RECEIPT_PARAMS, [
    contractAddr,
    auctionId,
    bidder,
    nonce,
    bidCommitment,
  ]);
}

export function decodeBidReceipt(data: Hex) {
  const [contractAddr, auctionId, bidder, nonce, bidCommitment] =
    decodeAbiParameters(BID_RECEIPT_PARAMS, data);
  return { contractAddr, auctionId, bidder, nonce, bidCommitment };
}

export function encodeClearResult(result: ClearResult): Hex {
  return encodeAbiParameters(CLEAR_RESULT_PARAMS, [
    result.contractAddr,
    result.auctionId,
    result.winner,
    result.unitPriceWei,
    result.winningNonce,
    result.winningCommitment,
    result.submittedBidCount,
    result.eligibleBidCount,
  ]);
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

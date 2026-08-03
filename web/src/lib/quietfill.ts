/** QuietFillAuction ABI (the slice the app uses) and shared helpers. */

import { parseAbi } from "viem";

export const quietFillAbi = parseAbi([
  "function BASE_TOKEN() view returns (address)",
  "function QUOTE_TOKEN() view returns (address)",
  "function createAuction(uint256 baseAmount, uint256 floorPriceWei, uint256 ceilingPriceWei, uint64 bidDeadline, uint64 settleDeadline) returns (uint256)",
  "function submitPrivateBid(uint256 auctionId, bytes encryptedBid) payable returns (bytes32)",
  "function requestClear(uint256 auctionId) payable returns (bytes32)",
  "function cancelTimedOutAuction(uint256 auctionId)",
  "function withdrawQuote(uint256 auctionId)",
  "function quoteEscrow(uint256 auctionId, address bidder) view returns (uint256)",
  "function quoteAmount(uint256 baseAmount, uint256 unitPriceWei) pure returns (uint256)",
  "function nextAuctionId() view returns (uint256)",
  "function getAuction(uint256 auctionId) view returns ((address seller, address teeId, uint256 baseAmount, uint256 floorPriceWei, uint256 ceilingPriceWei, uint256 maxQuoteAmount, uint64 bidDeadline, uint64 settleDeadline, bytes32 clearInstructionId, address winner, uint256 clearingPriceWei, uint256 quotePaid, uint256 submittedBidCount, uint256 eligibleBidCount, uint8 state))",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, uint256 baseAmount, uint256 floorPriceWei, uint256 ceilingPriceWei, uint256 maxQuoteAmount, uint64 bidDeadline, uint64 settleDeadline)",
  "event PrivateBidSubmitted(uint256 indexed auctionId, address indexed bidder, bytes32 indexed instructionId, bool escrowCreated)",
  "event ClearRequested(uint256 indexed auctionId, bytes32 indexed instructionId)",
  "event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 clearingPriceWei, uint256 quotePaid, bytes32 winningCommitment, uint64 winningNonce)",
  "event AuctionCancelled(uint256 indexed auctionId)",
  "event QuoteRefunded(uint256 indexed auctionId, address indexed bidder, uint256 amount)",
]);

/** settleAuction as explicit JSON ABI — the tuple keeps exact field names. */
export const settleAbi = [
  {
    type: "function",
    name: "settleAuction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auctionId", type: "uint256" },
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "contractAddr", type: "address" },
          { name: "auctionId", type: "uint256" },
          { name: "winner", type: "address" },
          { name: "unitPriceWei", type: "uint256" },
          { name: "winningNonce", type: "uint64" },
          { name: "winningCommitment", type: "bytes32" },
          { name: "submittedBidCount", type: "uint256" },
          { name: "eligibleBidCount", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const AUCTION_STATES = [
  "None",
  "Open",
  "ClearRequested",
  "Settled",
  "NoFill",
  "Cancelled",
] as const;

/** Fee in wei forwarded to the registry with every instruction. */
export const INSTRUCTION_FEE_WEI = 1_000_000n;

/** Unit prices are 1e18-scaled quote-per-base. */
export const PRICE_SCALE = 10n ** 18n;

export function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseUnits(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac) || frac.length > decimals) {
    throw new Error(`invalid amount: ${value}`);
  }
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

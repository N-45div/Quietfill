import { hexToBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import {
  decodeBidReceipt,
  decodeClearResult,
  encodeClearMessage,
  encodePrivateBid,
  type PrivateBid,
} from "../app/abi.js";
import * as handlers from "../app/handlers.js";

const CONTRACT_A = "0x1000000000000000000000000000000000000001" as Address;
const CONTRACT_B = "0x1000000000000000000000000000000000000002" as Address;
const ALICE = "0x2000000000000000000000000000000000000001" as Address;
const BOB = "0x2000000000000000000000000000000000000002" as Address;
const SALT_A = `0x${"11".repeat(32)}` as Hex;
const SALT_B = `0x${"22".repeat(32)}` as Hex;

const identityDecryptor = {
  async decrypt(ciphertext: Uint8Array) {
    return ciphertext;
  },
};

function bid(overrides: Partial<PrivateBid> = {}): PrivateBid {
  return {
    bidder: ALICE,
    contractAddr: CONTRACT_A,
    auctionId: 1n,
    nonce: 1n,
    unitPriceWei: 2_000_000_000_000_000_000n,
    salt: SALT_A,
    ...overrides,
  };
}

async function submit(value: PrivateBid) {
  return handlers.handlePrivateBid(encodePrivateBid(value));
}

function clear(overrides: Partial<Parameters<typeof encodeClearMessage>[0]> = {}) {
  return handlers.handleClear(
    encodeClearMessage({
      auctionId: 1n,
      contractAddr: CONTRACT_A,
      floorPriceWei: 1_800_000_000_000_000_000n,
      ceilingPriceWei: 2_200_000_000_000_000_000n,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  handlers.resetState();
  handlers.setDecryptorForTests(identityDecryptor);
});

describe("private bid receipts", () => {
  it("decrypts a bid and returns a price-free public receipt", async () => {
    const result = await submit(bid());
    expect(result[1]).toBe(1);

    const receipt = decodeBidReceipt(result[0] as Hex);
    expect(receipt.contractAddr).toBe(CONTRACT_A);
    expect(receipt.auctionId).toBe(1n);
    expect(receipt.bidder).toBe(ALICE);
    expect(receipt.nonce).toBe(1n);
    expect(receipt.bidCommitment).not.toBe(zeroHash);
    expect(result[0]).not.toContain("1bc16d674ec80000");
  });

  it("allows replacement only with a higher nonce", async () => {
    expect((await submit(bid()))[1]).toBe(1);
    expect((await submit(bid({ nonce: 1n, unitPriceWei: 2_100_000_000_000_000_000n })))[1]).toBe(0);
    expect((await submit(bid({ nonce: 2n, unitPriceWei: 2_100_000_000_000_000_000n })))[1]).toBe(1);

    const result = clear();
    expect(decodeClearResult(result[0] as Hex).unitPriceWei).toBe(
      2_100_000_000_000_000_000n,
    );
  });

  it("rejects malformed and invalid bids", async () => {
    expect((await handlers.handlePrivateBid("0x"))[1]).toBe(0);
    expect((await submit(bid({ bidder: zeroAddress })))[1]).toBe(0);
    expect((await submit(bid({ auctionId: 0n })))[1]).toBe(0);
    expect((await submit(bid({ nonce: 0n })))[1]).toBe(0);
    expect((await submit(bid({ unitPriceWei: 0n })))[1]).toBe(0);
    expect((await submit(bid({ salt: zeroHash })))[1]).toBe(0);
  });

  it("does not expose prices through state", async () => {
    await submit(bid());
    expect(handlers.reportState()).toEqual({
      auctionsTracked: 1,
      privateBidCount: 1,
      pricesExposed: false,
    });
  });
});

describe("deterministic clearing", () => {
  it("selects the highest eligible bid", async () => {
    await submit(bid({ bidder: ALICE, unitPriceWei: 1_950_000_000_000_000_000n }));
    await submit(
      bid({
        bidder: BOB,
        unitPriceWei: 2_050_000_000_000_000_000n,
        salt: SALT_B,
      }),
    );

    const result = decodeClearResult(clear()[0] as Hex);
    expect(result.winner).toBe(BOB);
    expect(result.unitPriceWei).toBe(2_050_000_000_000_000_000n);
    expect(result.submittedBidCount).toBe(2n);
    expect(result.eligibleBidCount).toBe(2n);
  });

  it("ignores bids outside the immutable price collar", async () => {
    await submit(bid({ bidder: ALICE, unitPriceWei: 2_500_000_000_000_000_000n }));
    await submit(
      bid({
        bidder: BOB,
        unitPriceWei: 2_100_000_000_000_000_000n,
        salt: SALT_B,
      }),
    );

    const result = decodeClearResult(clear()[0] as Hex);
    expect(result.winner).toBe(BOB);
    expect(result.submittedBidCount).toBe(2n);
    expect(result.eligibleBidCount).toBe(1n);
  });

  it("breaks equal-price ties by the lower bidder address", async () => {
    await submit(bid({ bidder: BOB, salt: SALT_B }));
    await submit(bid({ bidder: ALICE, salt: SALT_A }));
    expect(decodeClearResult(clear()[0] as Hex).winner).toBe(ALICE);
  });

  it("returns an explicit no-fill result", () => {
    const result = decodeClearResult(clear()[0] as Hex);
    expect(result.winner).toBe(zeroAddress);
    expect(result.unitPriceWei).toBe(0n);
    expect(result.winningCommitment).toBe(zeroHash);
    expect(result.submittedBidCount).toBe(0n);
    expect(result.eligibleBidCount).toBe(0n);
  });

  it("isolates auctions by contract and auction id", async () => {
    await submit(bid({ contractAddr: CONTRACT_B, unitPriceWei: 2_100_000_000_000_000_000n }));
    expect(decodeClearResult(clear()[0] as Hex).winner).toBe(zeroAddress);
    expect(
      decodeClearResult(clear({ contractAddr: CONTRACT_B })[0] as Hex).winner,
    ).toBe(ALICE);
  });

  it("rejects an invalid collar", () => {
    const result = clear({
      floorPriceWei: 3n,
      ceilingPriceWei: 2n,
    });
    expect(result[1]).toBe(0);
    expect(result[2]).toContain("ceiling price");
  });
});

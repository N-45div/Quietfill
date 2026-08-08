import { encodeAbiParameters, hexToBytes, parseAbiParameters, type Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeBidEnvelope } from "../app/abi.js";
import { VERSION } from "../app/config.js";
import * as handlers from "../app/handlers.js";
import { bytesToHex, stringToBytes32Hex } from "../base/encoding.js";
import { Server } from "../base/server.js";

const CONTRACT = "0x1000000000000000000000000000000000000001" as Address;
const BIDDER = "0x2000000000000000000000000000000000000001" as Address;
const BID_PARAMS = parseAbiParameters(
  "(address bidder, address contractAddr, uint256 auctionId, uint64 nonce, uint256 unitPriceWei, bytes32 salt)",
);

let server: Server;

beforeEach(() => {
  handlers.resetState();
  handlers.setDecryptorForTests({
    async decrypt(ciphertext: Uint8Array) {
      return ciphertext;
    },
  });
  server = new Server(0, 0, VERSION, handlers.register, handlers.reportState);
});

function action(opCommand: string, original: Uint8Array): string {
  const id = `0x${"11".repeat(32)}`;
  const fixed = {
    instructionId: id,
    opType: stringToBytes32Hex("QUIETFILL"),
    opCommand: stringToBytes32Hex(opCommand),
    originalMessage: bytesToHex(original),
  };
  return JSON.stringify({
    data: {
      id,
      type: "instruction",
      submissionTag: "submit",
      message: bytesToHex(Buffer.from(JSON.stringify(fixed))),
    },
  });
}

describe("QuietFill wire server", () => {
  it("routes a private bid and preserves the FCC ActionResult shape", async () => {
    const plaintext = encodeAbiParameters(BID_PARAMS, [{
      bidder: BIDDER,
      contractAddr: CONTRACT,
      auctionId: 1n,
      nonce: 1n,
      unitPriceWei: 2_000_000_000_000_000_000n,
      salt: `0x${"22".repeat(32)}`,
    }]);
    const envelope = encodeBidEnvelope({
      auctionId: 1n,
      bidder: BIDDER,
      ciphertext: plaintext,
    });
    const [status, body] = await server.handleRequest(
      "POST",
      "/action",
      action("QF_PRIVATE_BID", hexToBytes(envelope)),
    );
    const result = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect(result.status).toBe(1);
    expect(result.opType).toBe(stringToBytes32Hex("QUIETFILL"));
    expect(result.opCommand).toBe(stringToBytes32Hex("QF_PRIVATE_BID"));
    expect(result.submissionTag).toBe("submit");
    expect(result.version).toBe(VERSION);
    expect(Object.keys(result).sort()).toEqual([
      "additionalResultStatus",
      "data",
      "id",
      "log",
      "opCommand",
      "opType",
      "status",
      "submissionTag",
      "version",
    ]);
  });

  it("returns count-free, price-free state", async () => {
    const [status, body] = await server.handleRequest("GET", "/state", "");
    expect(status).toBe(200);
    expect((body as { state: unknown }).state).toEqual({
      pricesExposed: false,
      bidsExposed: false,
    });
  });

  it("rejects unknown operations", async () => {
    const [status] = await server.handleRequest(
      "POST",
      "/action",
      action("UNKNOWN", new Uint8Array()),
    );
    expect(status).toBe(501);
  });
});

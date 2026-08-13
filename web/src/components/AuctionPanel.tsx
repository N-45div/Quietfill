import { useCallback, useEffect, useState } from "react";
import {
  encodeFunctionData,
  hexToBytes,
  parseEventLogs,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
} from "viem";

import type { AppContext } from "../App";
import { eciesEncrypt } from "../lib/ecies";
import {
  decodeBidReceipt,
  decodeClearResult,
  encodePrivateBid,
  fetchActionResponse,
  fetchTeeInfo,
  teeIdFromPublicKey,
  teePublicKeyBytes,
  THRESHOLD_TAG,
} from "../lib/fcc";
import {
  AUCTION_STATES,
  erc20Abi,
  formatUnits,
  INSTRUCTION_FEE_WEI,
  parseUnits,
  quietFillAbi,
  settleAbi,
} from "../lib/quietfill";
import { explorerTxUrl } from "../lib/wallet";

type Auction = {
  seller: `0x${string}`;
  teeId: `0x${string}`;
  baseAmount: bigint;
  floorPriceWei: bigint;
  ceilingPriceWei: bigint;
  maxQuoteAmount: bigint;
  bidDeadline: bigint;
  settleDeadline: bigint;
  clearInstructionId: Hex;
  winner: `0x${string}`;
  clearingPriceWei: bigint;
  quotePaid: bigint;
  submittedBidCount: bigint;
  eligibleBidCount: bigint;
  state: number;
};

/** Dealer + lifecycle side: bid on, clear, settle, and recover funds from an auction. */
export function AuctionPanel({ ctx }: { ctx: AppContext }) {
  const [auctionId, setAuctionId] = useState("");
  const [auction, setAuction] = useState<Auction | null>(null);
  const [price, setPrice] = useState("");
  const [priceEdited, setPriceEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [myEscrow, setMyEscrow] = useState<bigint>(0n);

  const { publicClient, walletClient, account, chain, contract, proxyUrl, log } = ctx;

  // Open on the newest auction. Guessing an id is not discovery, and landing on
  // an empty panel reads as a broken app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = (await publicClient.readContract({
          address: contract,
          abi: quietFillAbi,
          functionName: "nextAuctionId",
        })) as bigint;
        if (!cancelled && next > 1n) setAuctionId((next - 1n).toString());
      } catch {
        if (!cancelled) setAuctionId("1");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, contract]);

  const refresh = useCallback(async () => {
    const id = BigInt(auctionId || "0");
    if (id <= 0n) return;
    try {
      const a = (await publicClient.readContract({
        address: contract,
        abi: quietFillAbi,
        functionName: "getAuction",
        args: [id],
      })) as Auction;
      setAuction(a.state === 0 ? null : a);
      setMyEscrow(
        a.state === 0
          ? 0n
          : await publicClient.readContract({
              address: contract,
              abi: quietFillAbi,
              functionName: "quoteEscrow",
              args: [id, account],
            }),
      );
    } catch {
      setAuction(null);
    }
  }, [auctionId, publicClient, contract, account]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      log(`${label}: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const bid = run("bid", async () => {
    if (!auction) throw new Error("load an auction first");
    const id = BigInt(auctionId);

    log("Fetching the auction's TEE public key from the proxy…");
    const info = await fetchTeeInfo(proxyUrl);
    const teeId = teeIdFromPublicKey(info.teeInfo.publicKey);
    if (teeId.toLowerCase() !== auction.teeId.toLowerCase()) {
      throw new Error(
        `proxy serves TEE ${teeId} but the auction is pinned to ${auction.teeId} — refusing to encrypt`,
      );
    }
    log(`TEE key verified against the on-chain pinned machine ${teeId}`, "ok");

    if (myEscrow === 0n) {
      const quoteToken = await publicClient.readContract({
        address: contract,
        abi: quietFillAbi,
        functionName: "QUOTE_TOKEN",
      });
      const allowance = await publicClient.readContract({
        address: quoteToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, contract],
      });
      if (allowance < auction.maxQuoteAmount) {
        log(`Approving the public ceiling escrow (${auction.maxQuoteAmount} quote units)…`);
        const hash = await walletClient.writeContract({
          address: quoteToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [contract, auction.maxQuoteAmount],
          chain,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        log("Quote approval mined", "ok", explorerTxUrl(chain, hash) ?? undefined);
      }
    }

    // The nonce must strictly increase per bidder; seconds-since-epoch does
    // that naturally for replacement bids.
    const nonce = BigInt(Math.floor(Date.now() / 1000));
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const plaintext = encodePrivateBid({
      bidder: account,
      contractAddr: contract,
      auctionId: id,
      nonce,
      // Exact decimal parse — going through a float here silently rounds some
      // prices, and the bid the enclave sees must be the one that was typed.
      unitPriceWei: parseUnits(price.trim(), 18),
      salt: salt as Hex,
    });
    const ciphertext = eciesEncrypt(teePublicKeyBytes(info.teeInfo.publicKey), hexToBytes(plaintext));
    log(`Bid encrypted in-browser (${ciphertext.length} bytes) — the price never leaves this tab unencrypted`);

    const hash = await walletClient.writeContract({
      address: contract,
      abi: quietFillAbi,
      functionName: "submitPrivateBid",
      args: [id, toHex(ciphertext)],
      value: INSTRUCTION_FEE_WEI,
      chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: quietFillAbi, logs: receipt.logs, eventName: "PrivateBidSubmitted" });
    log(`Bid submitted, instruction ${ev.args.instructionId}`, "ok", explorerTxUrl(chain, hash) ?? undefined);

    for (let i = 0; i < 15; i++) {
      const resp = await fetchActionResponse(proxyUrl, ev.args.instructionId);
      if (resp && resp.result.status !== 2) {
        if (resp.result.status !== 1) throw new Error(`TEE rejected the bid: ${resp.result.log}`);
        const r = decodeBidReceipt(resp.result.data);
        log(`TEE receipt: bidder ${r.bidder}, commitment ${r.bidCommitment} — no price inside`, "ok");
        return;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    log("No TEE receipt yet — the bid is on-chain; check the proxy later", "err");
  });

  const requestClear = run("requestClear", async () => {
    const id = BigInt(auctionId);
    const hash = await walletClient.writeContract({
      address: contract,
      abi: quietFillAbi,
      functionName: "requestClear",
      args: [id],
      value: INSTRUCTION_FEE_WEI,
      chain,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: quietFillAbi, logs: receipt.logs, eventName: "ClearRequested" });
    log(`Clear requested, instruction ${ev.args.instructionId}`, "ok", explorerTxUrl(chain, hash) ?? undefined);
  });

  const settle = run("settle", async () => {
    if (!auction) throw new Error("load an auction first");
    if (auction.clearInstructionId === zeroHash) throw new Error("no clear has been requested");
    const id = BigInt(auctionId);

    log("Fetching the TEE-signed clear result from the proxy…");
    const resp = await fetchActionResponse(proxyUrl, auction.clearInstructionId);
    if (!resp) throw new Error("proxy has no result yet — try again shortly");
    if (resp.result.status !== 1) throw new Error(`TEE clear failed: ${resp.result.log}`);
    if (resp.result.submissionTag !== THRESHOLD_TAG) {
      throw new Error(`result tag is "${resp.result.submissionTag}" — the contract needs the ${THRESHOLD_TAG} signature`);
    }

    const result = decodeClearResult(resp.result.data);
    log(
      result.winner === zeroAddress
        ? "TEE reports no eligible bids — settling as no-fill"
        : `TEE winner: ${result.winner} at ${formatUnits(result.unitPriceWei, 18)} — relaying with the TEE signature`,
    );

    const data = encodeFunctionData({
      abi: settleAbi,
      functionName: "settleAuction",
      args: [id, result, resp.signature],
    });
    const hash = await walletClient.sendTransaction({
      to: contract,
      data,
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log("Settlement verified on-chain against the pinned TEE signature", "ok", explorerTxUrl(chain, hash) ?? undefined);
  });

  const withdraw = run("withdraw", async () => {
    const hash = await walletClient.writeContract({
      address: contract,
      abi: quietFillAbi,
      functionName: "withdrawQuote",
      args: [BigInt(auctionId)],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log("Escrow refunded", "ok", explorerTxUrl(chain, hash) ?? undefined);
  });

  const cancel = run("cancel", async () => {
    const hash = await walletClient.writeContract({
      address: contract,
      abi: quietFillAbi,
      functionName: "cancelTimedOutAuction",
      args: [BigInt(auctionId)],
      chain,
      account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log("Auction cancelled after timeout — escrows recoverable", "ok", explorerTxUrl(chain, hash) ?? undefined);
  });

  // A bid outside the collar is accepted and escrowed but can never win, so
  // start inside it and say so plainly rather than letting the default price
  // silently disqualify the bid.
  useEffect(() => {
    if (!auction || priceEdited) return;
    const mid = (auction.floorPriceWei + auction.ceilingPriceWei) / 2n;
    setPrice(formatUnits(mid, 18));
  }, [auction, priceEdited]);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = auction ? AUCTION_STATES[auction.state] : null;

  let priceWei: bigint | null = null;
  try {
    priceWei = price.trim() === "" ? null : parseUnits(price.trim(), 18);
  } catch {
    priceWei = null;
  }
  const priceOutsideCollar =
    auction != null &&
    priceWei != null &&
    (priceWei < auction.floorPriceWei || priceWei > auction.ceilingPriceWei);
  const biddingOpen = auction?.state === 1 && now < auction.bidDeadline;
  const clearable = auction?.state === 1 && now >= auction.bidDeadline && now <= auction.settleDeadline;
  const settleable = auction?.state === 2 && now <= auction.settleDeadline;
  const timedOut = auction != null && (auction.state === 1 || auction.state === 2) && now > auction.settleDeadline;
  const terminal = auction != null && auction.state >= 3;

  return (
    <section className="panel">
      <h2>Auction</h2>
      <p className="hint">Load any auction to bid on it or drive its lifecycle.</p>
      <div className="row">
        <div>
          <label>Auction ID</label>
          <input value={auctionId} onChange={(e) => setAuctionId(e.target.value.trim())} />
        </div>
        <div>
          <label>Your bid (quote per base, stays private)</label>
          <input
            value={price}
            onChange={(e) => {
              setPriceEdited(true);
              setPrice(e.target.value);
            }}
            disabled={!biddingOpen}
          />
        </div>
      </div>
      {priceOutsideCollar && auction && (
        <p className="notice">
          {formatUnits(priceWei!, 18)} is outside this auction&apos;s collar (
          {formatUnits(auction.floorPriceWei, 18)} – {formatUnits(auction.ceilingPriceWei, 18)}). The
          bid would be escrowed but could never win.
        </p>
      )}

      {auction && state && (
        <dl className="facts">
          <dt>State</dt>
          <dd>
            <span className={`status ${state}`}>{state}</span>
          </dd>
          <dt>Collar</dt>
          <dd>
            {formatUnits(auction.floorPriceWei, 18)} – {formatUnits(auction.ceilingPriceWei, 18)}
          </dd>
          <dt>Pinned TEE</dt>
          <dd>{auction.teeId}</dd>
          <dt>Bids close</dt>
          <dd>{new Date(Number(auction.bidDeadline) * 1000).toLocaleString()}</dd>
          <dt>Your escrow</dt>
          <dd>{myEscrow.toString()}</dd>
          {auction.state === 3 && (
            <>
              <dt>Winner</dt>
              <dd>{auction.winner}</dd>
              <dt>Clearing price</dt>
              <dd>{formatUnits(auction.clearingPriceWei, 18)}</dd>
            </>
          )}
        </dl>
      )}
      {!auction && <p className="hint">No auction with this ID yet.</p>}

      <div>
        {biddingOpen && (
          <button onClick={bid} disabled={busy || priceOutsideCollar || priceWei == null}>
            {myEscrow > 0n ? "Replace encrypted bid" : "Escrow ceiling & bid"}
          </button>
        )}
        {clearable && (
          <button onClick={requestClear} disabled={busy}>
            Request clear
          </button>
        )}
        {settleable && (
          <button onClick={settle} disabled={busy}>
            Fetch signed result & settle
          </button>
        )}
        {timedOut && (
          <button className="danger" onClick={cancel} disabled={busy}>
            Cancel timed-out auction
          </button>
        )}
        {terminal && myEscrow > 0n && (
          <button className="secondary" onClick={withdraw} disabled={busy}>
            Withdraw escrow
          </button>
        )}
      </div>
    </section>
  );
}

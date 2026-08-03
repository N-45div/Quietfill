import { useEffect, useState } from "react";
import { parseEventLogs } from "viem";

import type { AppContext } from "../App";
import { fetchFtsoXrpUsd, type FtsoRate } from "../lib/ftso";
import { erc20Abi, INSTRUCTION_FEE_WEI, parseUnits, quietFillAbi } from "../lib/quietfill";
import { explorerTxUrl } from "../lib/wallet";

/** Seller side: escrow the FXRP lot and open an auction with a price collar. */
export function SellerPanel({ ctx }: { ctx: AppContext }) {
  const [lot, setLot] = useState("100");
  const [floor, setFloor] = useState("2.0");
  const [ceiling, setCeiling] = useState("2.5");
  const [windowMin, setWindowMin] = useState("10");
  const [busy, setBusy] = useState(false);
  const [ftso, setFtso] = useState<FtsoRate | null>(null);

  useEffect(() => {
    let alive = true;
    fetchFtsoXrpUsd()
      .then((r) => alive && setFtso(r))
      .catch(() => alive && setFtso(null));
    return () => {
      alive = false;
    };
  }, []);

  const collarFromFtso = () => {
    if (!ftso) return;
    setFloor((ftso.price * 0.95).toFixed(4));
    setCeiling((ftso.price * 1.05).toFixed(4));
    ctx.log(`Collar set from the FTSO on-chain rate: $${ftso.price.toFixed(4)} ±5%`);
  };

  const create = async () => {
    setBusy(true);
    try {
      const { publicClient, walletClient, account, chain, contract, log } = ctx;

      const baseToken = await publicClient.readContract({
        address: contract,
        abi: quietFillAbi,
        functionName: "BASE_TOKEN",
      });
      const decimals = await publicClient.readContract({
        address: baseToken,
        abi: erc20Abi,
        functionName: "decimals",
      });
      const baseAmount = parseUnits(lot, decimals);
      const floorWei = parseUnits(floor, 18);
      const ceilingWei = parseUnits(ceiling, 18);
      const now = Math.floor(Date.now() / 1000);
      const bidDeadline = BigInt(now + Number(windowMin) * 60);
      const settleDeadline = bidDeadline + 3600n;

      const allowance = await publicClient.readContract({
        address: baseToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, contract],
      });
      if (allowance < baseAmount) {
        log(`Approving ${lot} base tokens for escrow…`);
        const hash = await walletClient.writeContract({
          address: baseToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [contract, baseAmount],
          chain,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        log("Base token approval mined", "ok", explorerTxUrl(chain, hash) ?? undefined);
      }

      log("Creating auction…");
      const hash = await walletClient.writeContract({
        address: contract,
        abi: quietFillAbi,
        functionName: "createAuction",
        args: [baseAmount, floorWei, ceilingWei, bidDeadline, settleDeadline],
        chain,
        account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const [created] = parseEventLogs({
        abi: quietFillAbi,
        logs: receipt.logs,
        eventName: "AuctionCreated",
      });
      log(
        `Auction #${created.args.auctionId} created — collar ${floor}–${ceiling}, bids close in ${windowMin} min`,
        "ok",
        explorerTxUrl(chain, hash) ?? undefined,
      );
    } catch (e) {
      ctx.log(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Sell a lot</h2>
      <p className="hint">
        Escrows the FXRP lot up front. The registry pins one TEE to the auction; only its
        signature can ever settle it. Instruction fee: {INSTRUCTION_FEE_WEI.toString()} wei.
      </p>
      <div className="row">
        <div>
          <label>Lot size (base tokens)</label>
          <input value={lot} onChange={(e) => setLot(e.target.value)} />
        </div>
        <div>
          <label>Bid window (minutes)</label>
          <input value={windowMin} onChange={(e) => setWindowMin(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div>
          <label>Floor price (quote per base)</label>
          <input value={floor} onChange={(e) => setFloor(e.target.value)} />
        </div>
        <div>
          <label>Ceiling price (quote per base)</label>
          <input value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </div>
      </div>
      <button onClick={create} disabled={busy}>
        {busy ? "Working…" : "Escrow lot & create auction"}
      </button>
      <button
        className="secondary"
        onClick={collarFromFtso}
        disabled={!ftso}
        title={ftso ? `FTSO XRP/USD: $${ftso.price.toFixed(4)}` : "FTSO rate unavailable"}
      >
        Collar from FTSO ±5%
      </button>
    </section>
  );
}

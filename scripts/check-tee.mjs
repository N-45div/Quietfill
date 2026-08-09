/**
 * Pre-demo health check for the hosted FCC stack. Zero dependencies — run it
 * with plain node.
 *
 *   node scripts/check-tee.mjs
 *
 * tee-node regenerates its identity on every restart, so a restarted proxy
 * serves a TEE that the registry no longer pins. Auctions created in that
 * state pin a machine nobody is running, and bidding is impossible until it
 * is fixed. This reports that drift before it costs you a demo.
 */
const PROXY = process.env.EXT_PROXY_URL ?? "https://quietfill-fcc.onrender.com";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXTENSION_ID = BigInt(process.env.EXTENSION_ID_DEC ?? "66046");

let rpcId = 0;
const rpc = async (method, params = []) => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
};

const selector = async (sig) => (await rpc("web3_sha3", [`0x${Buffer.from(sig).toString("hex")}`])).slice(0, 10);
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const addrFrom = (word32) => `0x${word32.slice(-40)}`;

const fail = (msg) => {
  console.error(`\n  FAIL  ${msg}`);
  process.exitCode = 1;
};

console.log(`proxy    ${PROXY}`);
console.log(`chain    ${RPC}`);
console.log(`extension ${EXTENSION_ID}\n`);

// 1 — is the proxy answering, and how fast (a slow first byte means it was asleep)
const started = Date.now();
let info;
try {
  info = await fetch(`${PROXY}/info`, { signal: AbortSignal.timeout(120000) }).then((r) => r.json());
} catch (e) {
  fail(`proxy unreachable: ${e.message}`);
  process.exit(1);
}
const ms = Date.now() - started;
console.log(`  ok    /info answered in ${(ms / 1000).toFixed(1)}s${ms > 5000 ? "  (cold start — it had gone idle)" : ""}`);

// 2 — derive the TEE identity the proxy is currently serving
const pubkey = `0x${word(info.teeInfo.publicKey.x)}${word(info.teeInfo.publicKey.y)}`;
const liveTee = addrFrom(await rpc("web3_sha3", [pubkey]));
console.log(`  ok    live TEE ${liveTee}`);

// 3 — which machine will the contract actually pin?
const call = async (sig, argsHex) =>
  rpc("eth_call", [{ to: MANAGER, data: `${await selector(sig)}${argsHex}` }, "latest"]);

// createAuction pins whatever getRandomTeeIds returns, and that selection is
// random across the active set — so sample it rather than trusting one call.
const idHex = word(`0x${EXTENSION_ID.toString(16)}`);
const picks = new Set();
for (let i = 0; i < 5; i++) {
  const res = await call("getRandomTeeIds(uint256,uint256)", idHex + word("0x1"));
  picks.add(addrFrom(res.slice(2).slice(128, 192)).toLowerCase());
  if (i < 4) await new Promise((r) => setTimeout(r, 2500));
}
console.log(`  ok    registry pinned over 5 samples: ${[...picks].join(", ")}`);

const live = liveTee.toLowerCase();
if (!picks.has(live)) {
  fail(
    "the proxy's TEE is NOT what the registry pins — auctions created now cannot be bid on.\n" +
      "        Re-run ./scripts/post-build.sh, then retire the stale machine:\n" +
      `        cast send ${MANAGER} "pause(address)" ${[...picks][0]} --private-key <owner> --rpc-url ${RPC}`,
  );
} else if (picks.size > 1) {
  fail(
    "more than one machine is being pinned, and only the live one can serve bids.\n" +
      "        Retire every address above except " + live + " with pause().",
  );
} else {
  console.log("\n  PASS  the live TEE is the only machine being pinned.");
}

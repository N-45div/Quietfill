/**
 * Records a real end-to-end QuietFill auction against the hosted app.
 *
 * The browser signs genuine Coston2 transactions through an injected EIP-1193
 * provider backed by viem, so nothing in the resulting video is staged. Scene
 * captions are overlaid because the recording has no narration track.
 *
 *   npm i playwright viem && npx playwright install chromium
 *   DEMO_PRIVATE_KEY=0x... node record-demo.mjs
 *
 * Output: demo/raw.webm plus demo/marks.json (segment offsets, for trimming
 * or speeding up the stretch where the enclave is producing its result).
 */
import fs from "node:fs";
import { chromium } from "playwright";
import { createWalletClient, createPublicClient, http, defineChain, keccak256, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SITE = process.env.DEMO_SITE ?? "https://quietfill-web.onrender.com";
const PROXY = process.env.DEMO_PROXY ?? "https://quietfill-fcc.onrender.com";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXTENSION_ID = BigInt(process.env.DEMO_EXTENSION_ID ?? "66046");
const PK = process.env.DEMO_PRIVATE_KEY;
if (!PK) throw new Error("set DEMO_PRIVATE_KEY to a funded Coston2 key");

const LOT = process.env.DEMO_LOT ?? "2";
const BID_PRICE = process.env.DEMO_BID ?? "1.05";
const BID_WINDOW_MIN = "1";

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: coston2, transport: http(RPC) });
const pub = createPublicClient({ chain: coston2, transport: http(RPC) });

// The TEE serving the proxy must be the one the registry will pin, or the app
// correctly refuses to encrypt and the take is wasted. tee-node regenerates its
// identity on every restart, so this drifts whenever the host restarts.
const info = await fetch(`${PROXY}/info`).then((r) => r.json());
const pad = (h) => h.slice(2).padStart(64, "0");
const pubkeyHex = `0x${pad(info.teeInfo.publicKey.x)}${pad(info.teeInfo.publicKey.y)}`;
const liveTee = getAddress(`0x${keccak256(pubkeyHex).slice(-40)}`);
const [pinned] = await pub.readContract({
  address: TEE_MANAGER,
  abi: [
    {
      type: "function",
      name: "getRandomTeeIds",
      stateMutability: "view",
      inputs: [{ type: "uint256" }, { type: "uint256" }],
      outputs: [{ type: "address[]" }],
    },
  ],
  functionName: "getRandomTeeIds",
  args: [EXTENSION_ID, 1n],
});
console.log(`preflight: live TEE ${liveTee} / registry picks ${pinned}`);
if (liveTee.toLowerCase() !== pinned.toLowerCase()) {
  throw new Error(
    "TEE mismatch — the proxy restarted and rotated identity. Re-run post-build.sh, " +
      "then pause the stale machine: cast send <manager> 'pause(address)' <staleTee>",
  );
}

fs.rmSync("demo-out", { recursive: true, force: true });
fs.mkdirSync("demo-out", { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "demo-out", size: { width: 1440, height: 900 } },
});
const T0 = Date.now();
const marks = {};
const mark = (name) => {
  marks[name] = (Date.now() - T0) / 1000;
  console.log(`[mark] ${name} @ ${marks[name].toFixed(1)}s`);
};

const page = await context.newPage();
await page.exposeFunction("__qfSend", async (tx) => {
  const hash = await wallet.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
  });
  console.log("  tx sent:", hash);
  return hash;
});

await page.addInitScript(
  ([addr, rpc]) => {
    let id = 0;
    const rpcCall = async (method, params) => {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };
    window.ethereum = {
      isMetaMask: true,
      on() {},
      removeListener() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "eth_chainId") return "0x72";
        if (method === "eth_sendTransaction") return window.__qfSend(params[0]);
        return rpcCall(method, params);
      },
    };
    window.__cap = (text, sub) => {
      let el = document.getElementById("qf-cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "qf-cap";
        el.style.cssText =
          "position:fixed;left:28px;bottom:26px;z-index:99999;background:rgba(12,12,14,.94);" +
          "border:1px solid rgba(230,32,88,.55);border-left:3px solid #e62058;border-radius:3px;" +
          "padding:12px 18px;font-family:'IBM Plex Mono',ui-monospace,monospace;color:#f2f0ea;" +
          "box-shadow:0 12px 40px rgba(0,0,0,.6);max-width:760px;transition:opacity .25s ease";
        document.body.appendChild(el);
      }
      el.innerHTML =
        `<div style="font-size:15px">${text}</div>` +
        (sub ? `<div style="font-size:12px;color:#8e8e96;margin-top:5px">${sub}</div>` : "");
      el.style.opacity = "1";
    };
    window.__capHide = () => {
      const el = document.getElementById("qf-cap");
      if (el) el.style.opacity = "0";
    };
  },
  [account.address, RPC],
);

const cap = (t, s) => page.evaluate(([t, s]) => window.__cap(t, s), [t, s ?? ""]);
const capHide = () => page.evaluate(() => window.__capHide());
const wait = (ms) => page.waitForTimeout(ms);
const scrollTo = async (to, steps = 26) =>
  page.evaluate(
    async ([to, steps]) => {
      const from = window.scrollY;
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, from + ((to - from) * i) / steps);
        await new Promise((r) => setTimeout(r, 34));
      }
    },
    [to, steps],
  );

// 1 — the pitch
await page.goto(SITE, { waitUntil: "networkidle" });
await wait(1200);
await cap("QuietFill — sealed-bid FXRP auctions on Flare", "Live on Coston2, cleared inside a TEE");
await wait(4200);
await scrollTo(560);
await cap("Losing quotes stay sealed", "Only the winning price is ever revealed");
await wait(3600);
await scrollTo(1180);
await cap("One auction, four moves", "The website and the relayer are untrusted throughout");
await wait(4200);
await scrollTo(1900);
await cap("No admin keys", "No owner, no upgrades, no settable signer");
await wait(3800);

// 2 — the app
await capHide();
await page.goto(`${SITE}/#/trade`, { waitUntil: "networkidle" });
await wait(2500);
await cap("Live XRP rate — CoinGecko beside Flare's own FTSO oracle", "FTSO is read on-chain, not scraped");
await wait(5000);
await scrollTo(420);
await cap("Contract and FCC proxy, both live", `Coston2 · extension ${EXTENSION_ID}`);
await wait(4200);
await capHide();
await page.getByRole("button", { name: /connect wallet/i }).first().click();
await wait(2500);
await cap("Wallet connected — everything below is on-chain", account.address);
await wait(3000);
mark("connected");

// 3 — seller opens the auction
const sellerPanel = page.locator("section.panel").filter({ hasText: "Instruction fee" });
const auctionPanel = page.locator("section.panel").filter({ hasText: "Load any auction" });
await scrollTo(760);
await capHide();
await wait(600);
await cap("Seller: price the collar from the FTSO oracle", "Floor and ceiling at ±5% of the live rate");
const ftsoBtn = page.getByRole("button", { name: /collar from ftso/i });
await ftsoBtn.waitFor({ state: "visible" });
for (let i = 0; i < 30 && (await ftsoBtn.isDisabled()); i++) await wait(1000);
await ftsoBtn.click();
await wait(3200);
await sellerPanel.locator("input").nth(0).fill(LOT);
await wait(700);
await sellerPanel.locator("input").nth(1).fill(BID_WINDOW_MIN);
await wait(1200);
await cap(`Escrow ${LOT} FXRP and open the auction`, "The registry pins one TEE — no human chooses it");
await wait(2200);
await page.getByRole("button", { name: /escrow lot & create auction/i }).click();
await wait(1000);
await cap("Signing approval, then createAuction…", "Real transactions on Coston2");
await page.waitForFunction(() => document.body.innerText.includes("created — collar"), null, {
  timeout: 180000,
});
await wait(2500);
const auctionId = /Auction #(\d+) created/.exec(await page.locator(".log").innerText())?.[1];
mark("created");
await cap(`Auction #${auctionId} is open`, "FXRP escrowed, collar public, TEE pinned");
await wait(3600);

// 4 — dealer bids, encrypted in the browser
await scrollTo(1100);
await capHide();
await auctionPanel.locator("input").nth(0).fill(auctionId);
await wait(1800);
await auctionPanel.locator("input").nth(1).fill(BID_PRICE);
await wait(1200);
await cap("Dealer: the bid price never leaves this tab in the clear", "Encrypted to the pinned TEE's key, in-browser");
await wait(3400);
await page.getByRole("button", { name: /escrow ceiling & bid/i }).click();
await page.waitForFunction(() => document.body.innerText.includes("TEE receipt"), null, {
  timeout: 240000,
});
await wait(1500);
await cap("The TEE verified its own key against the chain, then took the bid", "Receipt returns a commitment — and no price");
await wait(5200);
mark("bid");

// 5 — the bid window
await scrollTo(700);
mark("waitStart");
const clearBtn = page.getByRole("button", { name: /request clear/i });
for (let left = 75; left > 0; left -= 5) {
  await cap(
    "Bid window open — the plaintext exists only inside the enclave",
    `Deadline in ~${left}s · nobody, including the seller, can read the bid`,
  );
  if (await clearBtn.isVisible().catch(() => false)) break;
  await wait(5000);
}
mark("waitEnd");

// 6 — clear and settle
await clearBtn.waitFor({ state: "visible", timeout: 180000 });
await scrollTo(1100);
await cap("Anyone may request the clear — permissionless", "The enclave decrypts, ranks, and signs");
await wait(2800);
await clearBtn.click();
await page.waitForFunction(() => document.body.innerText.includes("Clear requested"), null, {
  timeout: 180000,
});
await wait(3000);
mark("cleared");

await cap("Fetch the TEE-signed result and relay it on-chain", "The contract trusts the signature, not the relayer");
const settleBtn = page.getByRole("button", { name: /fetch signed result & settle/i });
await settleBtn.waitFor({ state: "visible", timeout: 180000 });
await wait(2600);
let settled = false;
for (let i = 0; i < 8 && !settled; i++) {
  await settleBtn.click();
  try {
    await page.waitForFunction(() => document.body.innerText.includes("Settlement verified"), null, {
      timeout: 50000,
    });
    settled = true;
  } catch {
    await cap("Waiting for the enclave's signed result…", "Retrying the proxy");
    await wait(6000);
  }
}
if (!settled) throw new Error("settlement did not complete");
await wait(2000);
await cap("Settled — verified against the pinned TEE's signature", "Winner paid, spread refunded, losers recoverable");
await wait(5000);
mark("settled");

await scrollTo(1000);
await wait(1500);
await cap("Auction settled on-chain", "Only the clearing price was ever revealed");
await wait(6000);
await capHide();
await wait(1500);
mark("end");

await context.close();
await browser.close();
const file = fs.readdirSync("demo-out").find((f) => f.endsWith(".webm"));
fs.renameSync(`demo-out/${file}`, "demo-out/raw.webm");
fs.writeFileSync("demo-out/marks.json", JSON.stringify(marks, null, 2));
console.log("saved demo-out/raw.webm");
console.log(JSON.stringify(marks, null, 2));

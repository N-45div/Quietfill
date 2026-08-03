/** Marketing landing: hero, how it works, security story, launch CTA. */

export function Home({ walletNotice }: { walletNotice: string }) {
  return (
    <>
      <section className="hero" id="top">
        <div>
          <span className="eyebrow">
            <b>Flare Confidential Compute</b> · sealed-bid RFQ · Coston2
          </span>
          <h1>
            Sell size.
            <br />
            Show <em>nothing.</em>
          </h1>
          <p className="sub">
            QuietFill auctions a fixed lot of <b>FXRP</b> to competing dealers whose bids are{" "}
            <b>encrypted in the browser</b> and opened only inside a hardware enclave. Losing
            quotes stay secret forever — the contract settles solely on the{" "}
            <b>TEE&apos;s chain-bound signature</b>. No order-book leakage, no trusted broker, no
            admin keys.
          </p>
          <div className="cta">
            <a href="#/trade">
              <button style={{ margin: 0 }}>Launch app</button>
            </a>
            <a href="#/how">
              <button className="secondary" style={{ margin: 0 }}>
                How it works
              </button>
            </a>
          </div>
          {walletNotice && <p className="notice">{walletNotice}</p>}
        </div>

        <div className="ticket" aria-hidden>
          <div className="t-head">
            <h3>AUCTION #7 — 5,000 FXRP</h3>
            <span className="status ClearRequested">Clearing</span>
          </div>
          <p className="t-sub">collar 2.00 – 2.50 USDT0 · 4 sealed bids</p>
          <div className="bidrow">
            <span className="who">0x93aF…D471</span>
            <span className="redact" />
          </div>
          <div className="bidrow winner">
            <span className="who">0x51C2…09eB — winner</span>
            <span className="price">2.41 USDT0</span>
          </div>
          <div className="bidrow">
            <span className="who">0xB7d0…33Aa</span>
            <span className="redact" />
          </div>
          <div className="bidrow">
            <span className="who">0x04eD…9C55</span>
            <span className="redact" />
          </div>
          <div className="t-foot">
            <span>losing bids: sealed in the enclave</span>
            <span className="sig">✓ TEE signature verified</span>
          </div>
        </div>
      </section>

      <section className="block" id="how">
        <div className="sec-head">
          <span className="idx">01</span>
          <h2>How it works</h2>
        </div>
        <p className="lead">
          One auction, four moves. The website and the relayer are untrusted throughout — the only
          authority is the TEE pinned to the auction from Flare&apos;s on-chain machine registry.
        </p>
        <div className="index">
          <div className="row">
            <span className="num">/ 01</span>
            <h3>Seller escrows the lot</h3>
            <p>
              The FXRP lot and a public floor/ceiling collar go on-chain. The contract pins one
              registry-selected TEE to the auction — no human chooses it.
            </p>
          </div>
          <div className="row">
            <span className="num">/ 02</span>
            <h3>Dealers bid in secret</h3>
            <p>
              Each dealer escrows the public worst case once, then encrypts their real price to the
              TEE&apos;s key in the browser. The chain carries only ciphertext.
            </p>
          </div>
          <div className="row">
            <span className="num">/ 03</span>
            <h3>The enclave clears</h3>
            <p>
              After the deadline anyone requests the clear. The TEE decrypts inside hardware, picks
              the best eligible price, and signs the result.
            </p>
          </div>
          <div className="row">
            <span className="num">/ 04</span>
            <h3>The contract settles</h3>
            <p>
              Anyone relays the signed result. The contract verifies the exact chain-bound TEE
              signature and atomically pays seller, winner, and refunds.
            </p>
          </div>
        </div>
      </section>

      <section className="block" id="security">
        <div className="sec-head">
          <span className="idx">02</span>
          <h2>What keeps it honest</h2>
        </div>
        <p className="lead">
          Four properties, enforced by the contract and the enclave — not by policy.
        </p>
        <div className="speclist">
          <div className="spec">
            <b>Losing quotes never leak</b>
            <span>
              Prices exist in plaintext only inside the enclave. Receipts, events, and state are
              price-free by construction.
            </span>
          </div>
          <div className="spec">
            <b>Nobody picks the winner</b>
            <span>
              Settlement requires the pinned TEE&apos;s signature over every result field — relayers
              cannot tamper, replay, or forge.
            </span>
          </div>
          <div className="spec">
            <b>No admin keys</b>
            <span>
              No owner, no upgrades, no settable signer. Selling, bidding, settling, and refunds are
              permissionless for any wallet.
            </span>
          </div>
          <div className="spec">
            <b>Funds always come back</b>
            <span>
              Escrow up front, and every ending — settled, no-fill, timeout — has a permissionless
              path that returns everyone&apos;s tokens.
            </span>
          </div>
        </div>
      </section>

      <div className="launch-band">
        <div>
          <h2>Ready to trade quietly?</h2>
          <p className="lead">
            Live market rate, sealed bidding, and TEE-verified settlement — all in the app.
          </p>
        </div>
        <a href="#/trade">
          <button style={{ margin: 0 }}>Launch app →</button>
        </a>
      </div>
    </>
  );
}

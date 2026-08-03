import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchFtsoXrpUsd, type FtsoRate } from "../lib/ftso";

/**
 * Live XRP/USD market rate (FXRP tracks XRP 1:1) from CoinGecko's public API.
 * Real data only — on failure the card says so and offers a retry, it never
 * draws an invented series. Single series: the title names it, no legend.
 */

const RANGES = [
  { label: "24H", days: 1 },
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
] as const;

type RangeLabel = (typeof RANGES)[number]["label"];

interface Point {
  t: number;
  p: number;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; points: Point[] };

const W = 800;
const H = 240;
const PAD = { top: 12, right: 56, bottom: 24, left: 8 };

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: v < 10 ? 4 : 2,
    maximumFractionDigits: v < 10 ? 4 : 2,
  });

function fmtTime(ms: number, days: number): string {
  const d = new Date(ms);
  return days <= 1
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MarketChart() {
  const [range, setRange] = useState<RangeLabel>("7D");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [hover, setHover] = useState<number | null>(null);
  const [ftso, setFtso] = useState<FtsoRate | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      fetchFtsoXrpUsd()
        .then((r) => alive && setFtso(r))
        .catch(() => alive && setFtso(null));
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const days = RANGES.find((r) => r.label === range)!.days;

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/ripple/market_chart?vs_currency=usd&days=${days}`,
      );
      if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
      const body = (await res.json()) as { prices: [number, number][] };
      const raw = body.prices.map(([t, p]) => ({ t, p }));
      if (raw.length < 2) throw new Error("not enough data points");
      // Downsample to ≤ 180 points so the line stays crisp.
      const step = Math.max(1, Math.floor(raw.length / 180));
      const points = raw.filter((_, i) => i % step === 0 || i === raw.length - 1);
      setState({ kind: "ready", points });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [days]);

  useEffect(() => {
    setHover(null);
    load();
  }, [load]);

  const geom = useMemo(() => {
    if (state.kind !== "ready") return null;
    const { points } = state;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const lo = Math.min(...points.map((d) => d.p));
    const hi = Math.max(...points.map((d) => d.p));
    const span = hi - lo || hi * 0.01;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (p: number) =>
      PAD.top + (1 - (p - (lo - span * 0.06)) / (span * 1.12)) * (H - PAD.top - PAD.bottom);
    const line = points.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(d.p).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${H - PAD.bottom}L${x(t0).toFixed(1)},${H - PAD.bottom}Z`;
    return { points, x, y, line, area, lo, hi };
  }, [state]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    geom.points.forEach((d, i) => {
      const dist = Math.abs(geom.x(d.t) - vx);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  };

  const first = geom?.points[0];
  const last = geom?.points[geom.points.length - 1];
  const change = first && last ? ((last.p - first.p) / first.p) * 100 : 0;
  const up = change >= 0;
  const hovered = geom && hover != null ? geom.points[hover] : null;

  const gridYs = [0.25, 0.5, 0.75].map((f) => PAD.top + f * (H - PAD.top - PAD.bottom));
  const tickXs = geom
    ? [0, 0.33, 0.66, 1].map((f) => {
        const i = Math.round(f * (geom.points.length - 1));
        return geom.points[i];
      })
    : [];

  return (
    <section className="panel wide chart-card">
      <div className="chart-head">
        <div>
          <h2>XRP market rate</h2>
          <p className="hint">
            FXRP tracks XRP — price your collar and bids off the live rate. Data: CoinGecko
            XRP/USD + Flare&apos;s FTSO oracle, read on-chain.
          </p>
        </div>
        <div className="seg" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              role="tab"
              aria-selected={range === r.label}
              className={range === r.label ? "on" : ""}
              onClick={() => setRange(r.label)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {state.kind === "loading" && <p className="chart-empty">Loading market data…</p>}
      {state.kind === "error" && (
        <p className="chart-empty">
          Market data unavailable ({state.message}).{" "}
          <button className="secondary" style={{ marginTop: 8 }} onClick={load}>
            Retry
          </button>
        </p>
      )}

      {geom && last && first && (
        <>
          <div className="chart-stats">
            <div className="stat">
              <span className="k">{fmtUsd((hovered ?? last).p)}</span>
              <span className="l">
                {hovered ? fmtTime(hovered.t, days) : "current"}
              </span>
            </div>
            {ftso && (
              <div className="stat">
                <span className="k">{fmtUsd(ftso.price)}</span>
                <span className="l">FTSO on-chain</span>
              </div>
            )}
            <div className="stat">
              <span className={`k ${up ? "up" : "down"}`}>
                {up ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
              </span>
              <span className="l">{range} change</span>
            </div>
            <div className="stat">
              <span className="k">{fmtUsd(geom.hi)}</span>
              <span className="l">{range} high</span>
            </div>
            <div className="stat">
              <span className="k">{fmtUsd(geom.lo)}</span>
              <span className="l">{range} low</span>
            </div>
          </div>

          <div className="chart-plot">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`XRP/USD ${range} price chart, currently ${fmtUsd(last.p)}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              <defs>
                <linearGradient id="qfArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e62058" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#e62058" stopOpacity="0" />
                </linearGradient>
              </defs>
              {gridYs.map((gy) => (
                <line key={gy} x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy} className="grid" />
              ))}
              {[geom.hi, (geom.hi + geom.lo) / 2, geom.lo].map((v, i) => (
                <text key={i} x={W - PAD.right + 8} y={geom.y(v) + 4} className="axis">
                  {fmtUsd(v)}
                </text>
              ))}
              {tickXs.map((d, i) => (
                <text
                  key={d.t}
                  x={geom.x(d.t)}
                  y={H - 6}
                  className="axis"
                  textAnchor={i === 0 ? "start" : i === tickXs.length - 1 ? "end" : "middle"}
                >
                  {fmtTime(d.t, days)}
                </text>
              ))}
              <path d={geom.area} fill="url(#qfArea)" />
              <path d={geom.line} className="series" vectorEffect="non-scaling-stroke" />
              {hovered && (
                <>
                  <line
                    x1={geom.x(hovered.t)}
                    x2={geom.x(hovered.t)}
                    y1={PAD.top}
                    y2={H - PAD.bottom}
                    className="crosshair"
                  />
                  <circle cx={geom.x(hovered.t)} cy={geom.y(hovered.p)} r="5" className="dot" />
                </>
              )}
            </svg>
            {hovered && svgRef.current && (
              <div
                className="chart-tip mono"
                style={{
                  left: `${(geom.x(hovered.t) / W) * 100}%`,
                  top: `${(geom.y(hovered.p) / H) * 100}%`,
                }}
              >
                {fmtUsd(hovered.p)} · {fmtTime(hovered.t, days)}
              </div>
            )}
          </div>

          <table className="sr-only">
            <caption>XRP/USD sampled prices, {range}</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Price (USD)</th>
              </tr>
            </thead>
            <tbody>
              {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => {
                const d = geom.points[Math.round(f * (geom.points.length - 1))];
                return (
                  <tr key={d.t}>
                    <td>{new Date(d.t).toISOString()}</td>
                    <td>{d.p.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

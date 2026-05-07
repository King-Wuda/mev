import { ALL_CHAINS, CHAINS, type ChainKey } from "./chains.js";
import {
  discoverPools,
  discoverV4Pools,
  findOpportunities,
  makeClient,
  readPoolStates,
  type DiscoveredPool,
  type Opportunity,
  type PoolState,
} from "./opportunities.js";
import { TOKENS } from "./dexes.js";
import {
  findTriangleOpportunities,
  type TriangleOpportunity,
} from "./triangle.js";
import { quoteTriangle } from "./quoter.js";
import type { TokenConfig } from "./dexes.js";

interface RunOpts {
  chains: ChainKey[];
  durationSec: number;
  intervalMs: number;
  minSpreadBps: number;
  notionalUsd: number;
  /** Estimated gas cost in USD per arb tx; opportunities below this are flagged. */
  gasUsd: number;
  /** If true, also report stablecoin depegs (price > minDepegBps from $1). */
  longTail: boolean;
  minDepegBps: number;
  /** Enable 3-hop triangle search; off for the heaviest chains by default. */
  triangles: boolean;
  /** Minimum net bps for triangle hits (after gas, expressed in bps of notional). */
  minTriangleBps: number;
  /** Cap how many triangle hits to print per tick — they can be noisy. */
  maxTriangleHits: number;
  /** If true, run Uniswap V3 QuoterV2 against top triangles for executable estimates. */
  quote: boolean;
}

function parseArgs(argv: string[]): RunOpts {
  const flags = argv.slice(0);
  const get = (k: string, def: string) => {
    const f = flags.find((x) => x.startsWith(`--${k}=`));
    return f ? f.split("=", 2)[1]! : def;
  };
  const chainArg = flags[0] && !flags[0].startsWith("--") ? flags[0] : "all";
  const chains: ChainKey[] =
    chainArg === "all"
      ? ALL_CHAINS
      : chainArg.split(",").filter((c): c is ChainKey => c in CHAINS);

  return {
    chains,
    durationSec: Number(get("seconds", "30")),
    intervalMs: Number(get("interval", "3000")),
    minSpreadBps: Number(get("min-bps", "5")),
    notionalUsd: Number(get("notional", "1000")),
    gasUsd: Number(get("gas-usd", "0.50")),
    longTail: flags.includes("--longtail") || flags.includes("--long-tail"),
    minDepegBps: Number(get("min-depeg-bps", "20")),
    triangles: !flags.includes("--no-triangles"),
    minTriangleBps: Number(get("min-tri-bps", "5")),
    maxTriangleHits: Number(get("max-tri", "8")),
    quote: flags.includes("--quote"),
  };
}

function fmtPrice(p: number): string {
  if (p === 0) return "0";
  if (p < 0.0001) return p.toExponential(3);
  if (p < 1) return p.toFixed(6);
  if (p < 1000) return p.toFixed(4);
  return p.toFixed(2);
}

function fmtFee(fee: number): string {
  return `${(fee / 10_000).toFixed(2)}%`;
}

function logOpportunity(o: Opportunity, notionalUsd: number): void {
  const netTag =
    o.netSpreadBps > 0
      ? `net=+${o.netSpreadBps.toFixed(1).padStart(5)}bps ~$${o.netProfitUsd.toFixed(2)}`
      : `net=${o.netSpreadBps.toFixed(1).padStart(6)}bps (fees > spread)`;
  console.log(
    `  ${o.pair.padEnd(14)} ` +
      `gross=${o.spreadBps.toFixed(1).padStart(6)}bps  ${netTag}  | ` +
      `BUY ${o.buyDex} ${fmtFee(o.buyFee)} @ ${fmtPrice(o.buyPrice)}  ` +
      `→ SELL ${o.sellDex} ${fmtFee(o.sellFee)} @ ${fmtPrice(o.sellPrice)}`
  );
}

interface ChainContext {
  key: ChainKey;
  pools: DiscoveredPool[];
}

async function setupChain(key: ChainKey): Promise<ChainContext | null> {
  const cfg = CHAINS[key];
  console.log(`[${cfg.name}] discovering pools (V3 + V4)...`);
  try {
    const client = makeClient(key);
    const [v3Pools, v4Pools] = await Promise.all([
      discoverPools(client, key),
      discoverV4Pools(client, key),
    ]);
    const pools = [...v3Pools, ...v4Pools];
    if (pools.length === 0) {
      console.log(`[${cfg.name}] no pools found (no DEX configs for this chain yet)`);
      return null;
    }
    const dexBreakdown = new Map<string, number>();
    for (const p of pools) {
      dexBreakdown.set(p.dex, (dexBreakdown.get(p.dex) ?? 0) + 1);
    }
    const summary = Array.from(dexBreakdown.entries())
      .map(([d, n]) => `${d}=${n}`)
      .join(", ");
    console.log(`[${cfg.name}] discovered ${pools.length} pools (${summary})`);
    return { key, pools };
  } catch (err) {
    console.log(`[${cfg.name}] discovery failed: ${(err as Error).message}`);
    return null;
  }
}

async function tickChain(
  ctx: ChainContext,
  minSpreadBps: number,
  notionalUsd: number
): Promise<{ opps: Opportunity[]; states: PoolState[] }> {
  const cfg = CHAINS[ctx.key];
  const client = makeClient(ctx.key);
  const states = await readPoolStates(client, ctx.pools);
  const minLiquidity = 10n ** 15n;
  const opps = findOpportunities(states, cfg.name, minSpreadBps, notionalUsd, minLiquidity);
  return { opps, states };
}

interface DepegFinding {
  chain: string;
  symbol: string;
  observedUsd: number;
  expectedUsd: number;
  bpsOff: number;
  pool: string;
  pair: string;
}

/**
 * Long-tail: detect stablecoins trading meaningfully off their $1 peg.
 * Uses any pool that pairs a stable with a known $1 reference token.
 *
 * The "expected" price comes from the token's `usdHint` — fine for stables
 * where the hint IS exactly $1. For LSTs (cbETH, wstETH) the hint is an
 * approximation; we skip those for the depeg detector.
 */
function findDepegs(
  states: PoolState[],
  chainName: string,
  chainKey: ChainKey,
  minBps: number
): DepegFinding[] {
  const tokens = TOKENS[chainKey];
  // Stables we expect to track $1 exactly. EURC tracks EUR not USD — exclude.
  const stableSymbols = new Set(["USDC", "USDT", "DAI", "USDbC"]);
  const stableAddrs = new Map(
    tokens
      .filter((t) => stableSymbols.has(t.symbol))
      .map((t) => [t.address.toLowerCase(), t])
  );

  const findings: DepegFinding[] = [];
  const seen = new Set<string>(); // dedupe by symbol+pool

  // Skip uninitialized / near-empty pools — their slot0 reads return prices
  // close to 0 or 1e-50, producing nonsense bps numbers.
  const minLiquidity = 10n ** 15n;
  const sanePriceRange = (p: number) => p > 0.5 && p < 2.0;

  for (const s of states) {
    if (s.liquidity < minLiquidity) continue;
    const t0Lc = s.pool.token0.address.toLowerCase();
    const t1Lc = s.pool.token1.address.toLowerCase();
    const t0Stable = stableAddrs.get(t0Lc);
    const t1Stable = stableAddrs.get(t1Lc);

    // Stable/Stable pool: price should be ~1.0; deviation = depeg of one of them.
    if (t0Stable && t1Stable) {
      if (!sanePriceRange(s.price)) continue;
      const off = Math.abs(s.price - 1) * 10_000;
      if (off >= minBps) {
        // We can't tell which of the two stables is depegged from one pool,
        // so report both with directional info.
        const cheaper = s.price < 1 ? t1Stable.symbol : t0Stable.symbol;
        const dearer = s.price < 1 ? t0Stable.symbol : t1Stable.symbol;
        const key = `${cheaper}-${dearer}-${s.pool.address}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({
            chain: chainName,
            symbol: `${dearer}>${cheaper}`,
            observedUsd: s.price < 1 ? s.price : 1 / s.price,
            expectedUsd: 1.0,
            bpsOff: off,
            pool: `${s.pool.dex} ${(s.pool.fee / 10_000).toFixed(2)}%`,
            pair: `${s.pool.token0.symbol}/${s.pool.token1.symbol}`,
          });
        }
      }
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Opportunity scanner — chains=${opts.chains.join(",")} ` +
      `duration=${opts.durationSec}s interval=${opts.intervalMs}ms ` +
      `minSpread=${opts.minSpreadBps}bps notional=$${opts.notionalUsd}\n`
  );

  // Phase 1: discover pools across configured chains
  const contexts = (
    await Promise.all(opts.chains.map((c) => setupChain(c)))
  ).filter((x): x is ChainContext => x !== null);

  if (contexts.length === 0) {
    console.log("\nno chains had discoverable pools. exiting.");
    process.exit(0);
  }

  console.log("\nstarting live scan...\n");

  const start = Date.now();
  const seenSpreads = new Map<string, number>();
  const seenDepegs = new Set<string>();
  const seenTriangles = new Map<string, number>();
  let totalUnique = 0;
  let totalTicks = 0;
  let totalProfitable = 0;
  let totalDepegs = 0;
  let totalTriangles = 0;
  let peak: Opportunity | null = null;
  let peakTriangle: TriangleOpportunity | null = null;

  while (Date.now() - start < opts.durationSec * 1000) {
    totalTicks++;
    const tickResults = await Promise.allSettled(
      contexts.map((ctx) => tickChain(ctx, opts.minSpreadBps, opts.notionalUsd))
    );

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    let printedHeader = false;
    for (let i = 0; i < tickResults.length; i++) {
      const r = tickResults[i]!;
      const ctx = contexts[i]!;
      if (r.status !== "fulfilled") {
        console.log(`[${CHAINS[ctx.key].name}] tick failed: ${r.reason}`);
        continue;
      }
      const { opps, states } = r.value;
      const chainName = CHAINS[ctx.key].name;

      for (const o of opps) {
        const key = `${o.chain}|${o.pair}|${o.buyDex}-${o.buyFee}|${o.sellDex}-${o.sellFee}`;
        const last = seenSpreads.get(key) ?? -1;
        if (Math.abs(o.spreadBps - last) >= 2) {
          if (!printedHeader) {
            console.log(`[t+${elapsed}s] ${chainName}:`);
            printedHeader = true;
          }
          logOpportunity(o, opts.notionalUsd);
          if (last < 0) totalUnique++;
          if (o.netProfitUsd > opts.gasUsd) totalProfitable++;
          seenSpreads.set(key, o.spreadBps);
          if (!peak || o.netSpreadBps > peak.netSpreadBps) peak = o;
        }
      }

      if (opts.longTail) {
        const depegs = findDepegs(states, chainName, ctx.key, opts.minDepegBps);
        for (const d of depegs) {
          const key = `${d.chain}|${d.symbol}|${d.pool}`;
          if (seenDepegs.has(key)) continue;
          seenDepegs.add(key);
          if (!printedHeader) {
            console.log(`[t+${elapsed}s] ${chainName}:`);
            printedHeader = true;
          }
          console.log(
            `  DEPEG ${d.symbol.padEnd(14)} ` +
              `${d.bpsOff.toFixed(1).padStart(6)}bps off $1.00 | ` +
              `observed=$${d.observedUsd.toFixed(4)} on ${d.pool} ${d.pair}`
          );
          totalDepegs++;
        }
      }

      if (opts.triangles) {
        // Anchor every cycle at high-value tokens — WETH first, then any
        // top-2 tokens by tx-hint (cbBTC, etc.). Most real searcher cycles
        // start and end in WETH, matching what we saw in the EigenPhi data.
        const tokens = TOKENS[ctx.key];
        const anchors = tokens
          .filter((t) =>
            ["WETH", "WMON", "WBERA", "WHYPE"].includes(t.symbol) ||
            (t.symbol === "USDC" && tokens.length <= 3)
          )
          .map((t) => t.address);

        const triangles = findTriangleOpportunities(
          states,
          chainName,
          anchors,
          opts.minTriangleBps,
          opts.notionalUsd,
          opts.gasUsd
        ).slice(0, opts.maxTriangleHits);

        // Optional: run QuoterV2 on the top V3-only triangles to get realized,
        // slippage-aware profit. Costs 1 eth_call per quote, so cap at 3.
        const symbolToToken = new Map(tokens.map((t) => [t.symbol, t]));
        let quotedResults: Awaited<ReturnType<typeof quoteTriangle>>[] = [];
        if (opts.quote && triangles.length > 0) {
          const client = makeClient(ctx.key);
          const v3OnlyTop = triangles
            .filter((t) => t.hops.every((h) => h.dex !== "Uniswap V4"))
            .slice(0, 3);
          quotedResults = await Promise.all(
            v3OnlyTop.map((t) => {
              const anchor = symbolToToken.get(t.anchor);
              if (!anchor) return Promise.resolve(null);
              return quoteTriangle(client, ctx.key, t, anchor, symbolToToken, opts.notionalUsd);
            })
          );
        }
        const quotedByPools = new Map<string, NonNullable<typeof quotedResults[number]>>();
        for (const q of quotedResults) {
          if (!q || !q.quotable) continue;
          const k = q.triangle.pools.slice().sort().join("|");
          quotedByPools.set(k, q);
        }

        for (const t of triangles) {
          const key = `${t.chain}|${t.pools.slice().sort().join("|")}`;
          const last = seenTriangles.get(key) ?? -1;
          if (Math.abs(t.netBps - last) < 1) continue; // change-only printing
          if (!printedHeader) {
            console.log(`[t+${elapsed}s] ${chainName}:`);
            printedHeader = true;
          }
          const route = t.hops
            .map((h) => `${h.from}→${h.to}(${h.dex.split(" ")[0]} ${fmtFee(h.fee)})`)
            .join("  ");
          const q = quotedByPools.get(t.pools.slice().sort().join("|"));
          const realizedTag = q
            ? `realized=${q.realizedBps.toFixed(1).padStart(5)}bps (slip ${q.slippageBps.toFixed(1)}bps)`
            : "";
          console.log(
            `  TRI ${t.anchor.padEnd(5)} ` +
              `gross=${t.grossBps.toFixed(1).padStart(6)}bps ` +
              `net=${t.netBps.toFixed(1).padStart(6)}bps ` +
              `~$${t.netProfitUsd.toFixed(2).padStart(6)} | ${route}` +
              (realizedTag ? `  ${realizedTag}` : "")
          );
          if (last < 0) totalTriangles++;
          seenTriangles.set(key, t.netBps);
          if (!peakTriangle || t.netBps > peakTriangle.netBps) peakTriangle = t;
        }
      }
    }

    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }

  console.log(
    `\n=== summary ===\n` +
      `ticks: ${totalTicks}\n` +
      `unique cross-pool opportunities: ${totalUnique}\n` +
      `profitable after gas ($${opts.gasUsd}/tx): ${totalProfitable}\n` +
      (opts.longTail ? `long-tail depegs (>${opts.minDepegBps}bps): ${totalDepegs}\n` : "") +
      (opts.triangles ? `unique 3-hop triangles: ${totalTriangles}\n` : "") +
      `peak 2-hop: ${
        peak
          ? `${peak.netSpreadBps.toFixed(1)} bps on ${peak.pair} ` +
            `(${peak.buyDex} ${fmtFee(peak.buyFee)} → ${peak.sellDex} ${fmtFee(peak.sellFee)}) ` +
            `~$${peak.netProfitUsd.toFixed(2)} on $${opts.notionalUsd.toLocaleString()}`
          : "none"
      }\n` +
      `peak 3-hop: ${
        peakTriangle
          ? `${peakTriangle.netBps.toFixed(1)} bps on ${peakTriangle.anchor} cycle ` +
            `${peakTriangle.hops.map((h) => h.from).join("→")}→${peakTriangle.anchor} ` +
            `~$${peakTriangle.netProfitUsd.toFixed(2)}`
          : "none"
      }`
  );
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

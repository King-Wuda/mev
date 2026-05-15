/**
 * Pattern miner — takes a stream of DecodedArb records and produces a
 * structured summary of who's doing what, with what tools, against which
 * tokens, on what time scales.
 *
 * The goal of this layer isn't more detection — it's *legibility*. After a
 * few hundred decoded arbs, the underlying searcher techniques become
 * visible: which contracts pay for which kinds of cycles, which DEX combos
 * dominate, what gross/gas ratios indicate "well-tuned" vs "spray-and-pray".
 */

import type { DecodedArb } from "./decode.js";
import type { DexFamily } from "./events.js";

export interface SearcherStats {
  /** Executor contract (tx.to). The EOA layer is noisy (rotated keys). */
  executor: string;
  /** Distinct EOAs seen calling this executor. */
  eoaCount: number;
  txCount: number;
  /** Sum of gross-profit-anchor values. Aggregated per anchor token — see
   *  `grossByAnchor` for per-token breakdown (mixing decimals is meaningless). */
  grossByAnchor: Record<string, bigint>;
  /** Sum of gasCostWei across all the searcher's txs. */
  totalGasWei: bigint;
  /** Histogram of cycle lengths: { 2: 5, 3: 88, 4: 12, ... } */
  cycleLengths: Record<number, number>;
  /** Which DEX combos this searcher uses. Keyed by sorted dex-family string,
   *  e.g. "v2+v3" or "curve+v3+v4". */
  dexCombos: Record<string, number>;
  /** Anchor token frequency. */
  anchors: Record<string, number>;
}

export interface PoolStats {
  poolId: string;
  family: DexFamily;
  /** Number of times this pool appears as a hop in any cycle. */
  hopCount: number;
  /** Distinct searchers that have hit it. */
  searcherCount: number;
}

export interface AggregateSummary {
  totalArbs: number;
  blockSpan: { first: bigint; last: bigint } | null;
  searchers: SearcherStats[];
  pools: PoolStats[];
  /** Top recurring full paths, by occurrence count. */
  pathFrequency: Array<{ path: string; count: number; cycleLen: number }>;
}

/**
 * Render a hop sequence as a stable path string: "WETH→USDC→cbETH→WETH"
 * (last token == first, by construction).
 */
function pathOf(arb: DecodedArb, symbolFor: (addr: string) => string): string {
  const tokens = [arb.hops[0]!.tokenIn, ...arb.hops.map((h) => h.tokenOut)];
  return tokens.map(symbolFor).join("→");
}

/**
 * Build a sorted DEX-combo key from a list of families. Stable across calls.
 */
function dexComboKey(mix: DexFamily[]): string {
  return mix.slice().sort().join("+");
}

export interface AggregateOptions {
  /** Optional map (lowercased address → symbol) to render paths legibly. */
  knownSymbols?: Map<string, string>;
  /** How many top entries of each kind to return. */
  topSearchers?: number;
  topPools?: number;
  topPaths?: number;
}

export function aggregate(
  arbs: DecodedArb[],
  opts: AggregateOptions = {}
): AggregateSummary {
  const knownSymbols = opts.knownSymbols ?? new Map();
  const topSearchers = opts.topSearchers ?? 20;
  const topPools = opts.topPools ?? 30;
  const topPaths = opts.topPaths ?? 20;

  const symbolFor = (addr: string): string => {
    const sym = knownSymbols.get(addr.toLowerCase());
    return sym ?? addr.slice(0, 8);
  };

  // Per-executor accumulation
  const bySearcher = new Map<string, SearcherStats & { _eoas: Set<string> }>();
  for (const arb of arbs) {
    const exec = (arb.executor ?? arb.searcher).toLowerCase();
    let s = bySearcher.get(exec);
    if (!s) {
      s = {
        executor: exec,
        eoaCount: 0,
        txCount: 0,
        grossByAnchor: {},
        totalGasWei: 0n,
        cycleLengths: {},
        dexCombos: {},
        anchors: {},
        _eoas: new Set(),
      };
      bySearcher.set(exec, s);
    }
    s.txCount++;
    s._eoas.add(arb.searcher.toLowerCase());
    s.totalGasWei += arb.gasCostWei;
    s.grossByAnchor[arb.anchor] = (s.grossByAnchor[arb.anchor] ?? 0n) + arb.grossProfitRaw;
    const len = arb.hops.length;
    s.cycleLengths[len] = (s.cycleLengths[len] ?? 0) + 1;
    const combo = dexComboKey(arb.dexMix);
    s.dexCombos[combo] = (s.dexCombos[combo] ?? 0) + 1;
    s.anchors[arb.anchor] = (s.anchors[arb.anchor] ?? 0) + 1;
  }
  for (const s of bySearcher.values()) {
    s.eoaCount = s._eoas.size;
  }
  const searchers = Array.from(bySearcher.values())
    .map(({ _eoas, ...rest }) => rest)
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, topSearchers);

  // Per-pool accumulation
  const byPool = new Map<string, { stats: PoolStats; _searchers: Set<string> }>();
  for (const arb of arbs) {
    const exec = (arb.executor ?? arb.searcher).toLowerCase();
    for (const hop of arb.hops) {
      let entry = byPool.get(hop.poolId);
      if (!entry) {
        entry = {
          stats: { poolId: hop.poolId, family: hop.family, hopCount: 0, searcherCount: 0 },
          _searchers: new Set(),
        };
        byPool.set(hop.poolId, entry);
      }
      entry.stats.hopCount++;
      entry._searchers.add(exec);
    }
  }
  for (const e of byPool.values()) e.stats.searcherCount = e._searchers.size;
  const pools = Array.from(byPool.values())
    .map((e) => e.stats)
    .sort((a, b) => b.hopCount - a.hopCount)
    .slice(0, topPools);

  // Path frequency
  const pathCounts = new Map<string, { count: number; cycleLen: number }>();
  for (const arb of arbs) {
    const p = pathOf(arb, symbolFor);
    const existing = pathCounts.get(p);
    if (existing) existing.count++;
    else pathCounts.set(p, { count: 1, cycleLen: arb.hops.length });
  }
  const pathFrequency = Array.from(pathCounts.entries())
    .map(([path, v]) => ({ path, count: v.count, cycleLen: v.cycleLen }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topPaths);

  // Block span
  let first: bigint | null = null;
  let last: bigint | null = null;
  for (const arb of arbs) {
    if (first === null || arb.blockNumber < first) first = arb.blockNumber;
    if (last === null || arb.blockNumber > last) last = arb.blockNumber;
  }

  return {
    totalArbs: arbs.length,
    blockSpan: first !== null && last !== null ? { first, last } : null,
    searchers,
    pools,
    pathFrequency,
  };
}

/**
 * Pretty-print a summary. Keeps it as plain console.log lines so the output
 * is greppable for downstream pipelines.
 */
export function printSummary(s: AggregateSummary, symbolFor?: (addr: string) => string): void {
  const sym = symbolFor ?? ((a: string) => a.slice(0, 8));
  console.log(`\n=== Arb pattern summary: ${s.totalArbs} cycles ===`);
  if (s.blockSpan) {
    console.log(`Blocks: ${s.blockSpan.first} → ${s.blockSpan.last}\n`);
  }

  console.log(`Top searchers (by tx count):`);
  for (const r of s.searchers) {
    const topCombo = Object.entries(r.dexCombos).sort((a, b) => b[1] - a[1])[0];
    const topAnchor = Object.entries(r.anchors).sort((a, b) => b[1] - a[1])[0];
    const cycleHist = Object.entries(r.cycleLengths)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${k}-hop:${v}`)
      .join(" ");
    console.log(
      `  ${r.executor}  txs=${r.txCount}  eoas=${r.eoaCount}  ` +
        `gas=${(Number(r.totalGasWei) / 1e18).toFixed(4)}eth  ` +
        `mix=${topCombo?.[0] ?? "-"}  anchor=${sym(topAnchor?.[0] ?? "")}  ` +
        `[${cycleHist}]`
    );
  }

  console.log(`\nTop pools (by hop count):`);
  for (const p of s.pools) {
    console.log(`  ${p.family.padEnd(8)} ${p.poolId.slice(0, 18)}…  hops=${p.hopCount}  searchers=${p.searcherCount}`);
  }

  console.log(`\nTop paths:`);
  for (const p of s.pathFrequency) {
    console.log(`  ${p.count.toString().padStart(4)}×  ${p.path}  (${p.cycleLen}-hop)`);
  }
  console.log("");
}

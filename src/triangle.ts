import type { Address } from "viem";
import type { TokenConfig } from "./dexes.js";
import type { PoolState } from "./opportunities.js";

/**
 * 3-hop arbitrage opportunity (triangle): anchor → midA → midB → anchor.
 *
 * EigenPhi data showed 14/15 mainnet arbs are 3-hop, not 2-hop. The cross-pool
 * spread analyzer (findOpportunities) only catches degenerate same-pair
 * cycles. This module finds true triangles, where the edge isn't pool A vs
 * pool B on the same pair, but a profitable round-trip through three
 * different token pools.
 */
export interface TriangleOpportunity {
  chain: string;
  anchor: string;
  /** Cycle path, in execution order. */
  hops: HopDescriptor[];
  /** Cycle output ratio after fees, expressed in bps. (rate - 1) × 10,000. */
  grossBps: number;
  /** grossBps minus the gas-cost-bps for the given notional. */
  netBps: number;
  /** Net profit at notional, after gas. */
  netProfitUsd: number;
  pools: Address[];
}

export interface HopDescriptor {
  dex: string;
  fee: number;
  from: string;
  to: string;
}

interface AdjEntry {
  state: PoolState;
  fromToken: TokenConfig;
  toToken: TokenConfig;
}

function buildAdjacency(states: PoolState[]): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  for (const s of states) {
    const t0 = s.pool.token0;
    const t1 = s.pool.token1;
    const k0 = t0.address.toLowerCase();
    const k1 = t1.address.toLowerCase();
    if (!adj.has(k0)) adj.set(k0, []);
    if (!adj.has(k1)) adj.set(k1, []);
    adj.get(k0)!.push({ state: s, fromToken: t0, toToken: t1 });
    adj.get(k1)!.push({ state: s, fromToken: t1, toToken: t0 });
  }
  return adj;
}

/**
 * Effective swap rate for a single hop (output per unit input), after fee.
 *
 * Pool stores token0/token1 by address sort. Its `price` is token1/token0.
 * If we're swapping from token0 → token1 we get `price` units out per unit in.
 * If we're swapping from token1 → token0 we get `1/price` units out per unit in.
 * Fee is fee_tier / 1_000_000.
 */
function hopRate(state: PoolState, from: TokenConfig): number {
  const fromIsToken0 =
    state.pool.token0.address.toLowerCase() === from.address.toLowerCase();
  const grossRate = fromIsToken0 ? state.price : 1 / state.price;
  const feeFraction = state.pool.fee / 1_000_000;
  return grossRate * (1 - feeFraction);
}

/**
 * Enumerate all anchor → midA → midB → anchor cycles, score each by net
 * profit, dedupe by pool-set, and return top hits sorted by USD profit.
 *
 * Performance note: the search is O(degree³). With ~300 pools and a
 * well-connected anchor like WETH, this can mean ~10k–100k candidates per
 * tick. We bail early on negative gross paths to keep it bounded.
 */
export function findTriangleOpportunities(
  states: PoolState[],
  chainName: string,
  anchors: Address[],
  minNetBps: number,
  notionalUsd: number,
  gasUsd: number,
  // Real V3 pools active for arb almost always carry >1e17 active liquidity.
  // Lower thresholds let stale/dead pools mispriced by tens of percent
  // contaminate the search and produce phantom 1000+bps "opportunities".
  minLiquidity: bigint = 10n ** 17n,
  // Anything beyond this is almost certainly stale-pool noise, not real.
  // The largest real triangle margins observed in production are <300 bps.
  maxRealisticGrossBps: number = 500
): TriangleOpportunity[] {
  const active = states.filter((s) => s.liquidity >= minLiquidity);
  if (active.length === 0) return [];

  const adj = buildAdjacency(active);
  const found: TriangleOpportunity[] = [];
  const seen = new Set<string>();
  // Gas expressed as bps of notional, so we can compare apples-to-apples.
  const gasBps = (gasUsd / notionalUsd) * 10_000;

  for (const anchorAddr of anchors) {
    const anchorKey = anchorAddr.toLowerCase();
    const anchorEdges = adj.get(anchorKey);
    if (!anchorEdges) continue;

    for (const e1 of anchorEdges) {
      const midAKey = e1.toToken.address.toLowerCase();
      if (midAKey === anchorKey) continue;
      const r1 = hopRate(e1.state, e1.fromToken);
      if (r1 <= 0 || !isFinite(r1)) continue;

      const midAEdges = adj.get(midAKey) ?? [];
      for (const e2 of midAEdges) {
        if (e2.state.pool.address === e1.state.pool.address) continue;
        const midBKey = e2.toToken.address.toLowerCase();
        if (midBKey === anchorKey || midBKey === midAKey) continue;
        const r2 = hopRate(e2.state, e2.fromToken);
        if (r2 <= 0 || !isFinite(r2)) continue;
        // Early-exit if first two hops already lose >5% — no triangle saves it.
        if (r1 * r2 < 0.95) continue;

        const midBEdges = adj.get(midBKey) ?? [];
        for (const e3 of midBEdges) {
          if (
            e3.state.pool.address === e1.state.pool.address ||
            e3.state.pool.address === e2.state.pool.address
          ) continue;
          if (e3.toToken.address.toLowerCase() !== anchorKey) continue;

          const r3 = hopRate(e3.state, e3.fromToken);
          if (r3 <= 0 || !isFinite(r3)) continue;

          const cycleRate = r1 * r2 * r3;
          if (cycleRate <= 1) continue;
          const grossBps = (cycleRate - 1) * 10_000;
          // Sanity gate: anything beyond maxRealisticGrossBps almost always
          // means one leg is a stale or oracle-broken pool. Real searcher
          // margins live in the <300 bps band.
          if (grossBps > maxRealisticGrossBps) continue;
          const netBps = grossBps - gasBps;
          if (netBps < minNetBps) continue;

          const poolIds = [
            e1.state.pool.address,
            e2.state.pool.address,
            e3.state.pool.address,
          ].slice().sort().join("|");
          const key = `${chainName}|${anchorKey}|${midAKey}|${midBKey}|${poolIds}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const netProfitUsd = (notionalUsd * netBps) / 10_000;
          found.push({
            chain: chainName,
            anchor: e1.fromToken.symbol,
            hops: [
              { dex: e1.state.pool.dex, fee: e1.state.pool.fee, from: e1.fromToken.symbol, to: e1.toToken.symbol },
              { dex: e2.state.pool.dex, fee: e2.state.pool.fee, from: e2.fromToken.symbol, to: e2.toToken.symbol },
              { dex: e3.state.pool.dex, fee: e3.state.pool.fee, from: e3.fromToken.symbol, to: e3.toToken.symbol },
            ],
            grossBps,
            netBps,
            netProfitUsd,
            pools: [
              e1.state.pool.address,
              e2.state.pool.address,
              e3.state.pool.address,
            ],
          });
        }
      }
    }
  }

  found.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return found;
}

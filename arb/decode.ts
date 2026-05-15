/**
 * Single-tx arbitrage decoder.
 *
 * Given a transaction receipt, this finds the swap events (across all five
 * DEX families), resolves their tokens, and tries to fit them into a closed
 * cycle: a → b → c → … → a, with same-token equality across edges.
 *
 * What "arb" means here:
 *   - The tx emits ≥2 swap events
 *   - When linearized in log-index order, consecutive swaps chain — output
 *     token of swap i equals input token of swap i+1
 *   - The path is closed: final output token equals first input token
 *   - Final output amount > first input amount (gross profit; gas not yet
 *     subtracted)
 *
 * This catches:
 *   - 2-hop arbs (A → B → A across two pools)
 *   - 3-hop triangles (A → B → C → A) — the most common shape
 *   - longer cycles
 *   - mixed-DEX cycles (V3 → V4 → Curve back to start)
 *
 * It does NOT catch:
 *   - Multi-cycle txs (a single tx executing two disjoint arbs back-to-back).
 *     A future pass can split the swap list into connected components.
 *   - Arbs that route through ERC-20 transfers without emitting a Swap event
 *     (e.g. direct pool drains, batch atomic swappers that use custom events).
 *   - Coinbase tips (miner bribes) — `netProfitNative` doesn't subtract them.
 */

import type {
  Address,
  Hex,
  PublicClient,
  Transaction,
  TransactionReceipt,
} from "viem";
import { ALL_SWAP_TOPICS, decodeOneSwap, type PartialSwap } from "./events.js";
import { resolveSwaps } from "./resolve.js";

export interface ArbHop {
  family: PartialSwap["family"];
  venue: Address;
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  logIndex: number;
}

export interface DecodedArb {
  chain: string;
  blockNumber: bigint;
  txHash: Hex;
  /** EOA that signed the tx. */
  searcher: Address;
  /** Contract the tx called — usually the searcher's executor. */
  executor: Address | null;
  /** Hops in execution order, forming the closed cycle. */
  hops: ArbHop[];
  /** Token that begins and ends the cycle. */
  anchor: string;
  /** Gross profit in the anchor token's smallest unit (post all hops). */
  grossProfitRaw: bigint;
  /** Native gas cost = gasUsed * effectiveGasPrice. */
  gasCostWei: bigint;
  /** Set of unique DEX families used. */
  dexMix: PartialSwap["family"][];
}

/**
 * Build a flow graph from the raw swap list and find the longest closed
 * chain starting from each candidate first-swap. The first swap that closes
 * back onto its input token wins; ties broken by chain length (prefer longer
 * cycles — they're more likely to be a deliberate arb than a coincidence).
 */
function findCycle(swaps: Array<PartialSwap & { tokenIn: string; tokenOut: string }>): ArbHop[] | null {
  if (swaps.length < 2) return null;
  // Sort by log index to mirror execution order.
  const ordered = swaps.slice().sort((a, b) => a.logIndex - b.logIndex);

  // Greedy: walk forward, chaining each swap whose tokenIn matches the
  // running tokenOut. Multiple branches can exist (a token can appear in
  // many swaps); we explore breadth-first with a small budget.
  const used = new Set<number>();
  // Best chain so far (by length, then by index of first swap).
  let best: ArbHop[] | null = null;

  function explore(startIdx: number): ArbHop[] | null {
    const startSwap = ordered[startIdx]!;
    const startTok = startSwap.tokenIn;
    const localChain: number[] = [startIdx];
    used.add(startIdx);
    let currentOut = startSwap.tokenOut;

    for (let i = startIdx + 1; i < ordered.length; i++) {
      if (used.has(i)) continue;
      const s = ordered[i]!;
      if (s.tokenIn !== currentOut) continue;
      localChain.push(i);
      used.add(i);
      currentOut = s.tokenOut;
      // Cycle closed?
      if (currentOut === startTok) {
        const hops: ArbHop[] = localChain.map((idx) => {
          const sw = ordered[idx]!;
          return {
            family: sw.family,
            venue: sw.venue,
            poolId: sw.poolId,
            tokenIn: sw.tokenIn,
            tokenOut: sw.tokenOut,
            amountIn: sw.amountIn,
            amountOut: sw.amountOut,
            logIndex: sw.logIndex,
          };
        });
        // Unwind 'used' marks for swaps we didn't include from this branch
        // (none in greedy walk; here for safety if we widen to backtracking).
        return hops;
      }
    }
    // No cycle from this start — unwind.
    for (const idx of localChain) used.delete(idx);
    return null;
  }

  for (let i = 0; i < ordered.length - 1; i++) {
    if (used.has(i)) continue;
    const cycle = explore(i);
    if (cycle && (!best || cycle.length > best.length)) {
      best = cycle;
    }
  }

  return best;
}

/**
 * The grossProfit of a closed cycle: amountOut of the final hop minus
 * amountIn of the first hop — both denominated in the anchor token.
 */
function computeGross(hops: ArbHop[]): { anchor: string; grossProfitRaw: bigint } {
  const first = hops[0]!;
  const last = hops[hops.length - 1]!;
  return {
    anchor: first.tokenIn,
    grossProfitRaw: last.amountOut - first.amountIn,
  };
}

export interface DecodeOptions {
  chain: string;
  /** Required for V4 swap resolution (PoolManager address). */
  poolManager?: Address;
  /** Used as upper bound when searching backward for V4 Initialize events. */
  searchUpToBlock?: bigint;
}

/**
 * Decode a single receipt. Returns null if no closed arb cycle is found.
 *
 * This is the foundation function — `scan.ts` calls it per-tx in a block;
 * a CLI can call it standalone with a tx hash.
 */
export async function decodeArbFromReceipt(
  client: PublicClient,
  tx: Transaction,
  receipt: TransactionReceipt,
  opts: DecodeOptions
): Promise<DecodedArb | null> {
  // Pre-filter logs to just swap-shaped events.
  const candidates = receipt.logs.filter((l) => {
    const t = l.topics[0];
    return t !== undefined && ALL_SWAP_TOPICS.has(t as Hex);
  });
  if (candidates.length < 2) return null;

  // Decode each into a PartialSwap.
  const partials: PartialSwap[] = [];
  for (const log of candidates) {
    const p = decodeOneSwap(log);
    if (p) partials.push(p);
  }
  if (partials.length < 2) return null;

  // Resolve tokens.
  const upTo = opts.searchUpToBlock ?? receipt.blockNumber;
  const resolved = await resolveSwaps(client, opts.chain, opts.poolManager, partials, upTo);
  if (resolved.length < 2) return null;

  // Find a closed cycle.
  const cycle = findCycle(resolved);
  if (!cycle || cycle.length < 2) return null;

  const { anchor, grossProfitRaw } = computeGross(cycle);
  // Profit must be positive to qualify as arb (a "rebalance" tx may close
  // a cycle but lose money — not an arb).
  if (grossProfitRaw <= 0n) return null;

  const dexMix = Array.from(new Set(cycle.map((h) => h.family)));
  const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);

  return {
    chain: opts.chain,
    blockNumber: receipt.blockNumber,
    txHash: receipt.transactionHash as Hex,
    searcher: receipt.from,
    executor: receipt.to ?? null,
    hops: cycle,
    anchor,
    grossProfitRaw,
    gasCostWei,
    dexMix,
  };
}

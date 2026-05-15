/**
 * Token-address resolution for swap events.
 *
 * Different DEX families emit different shapes:
 *   - V2/V3: pool address only — we need token0()/token1() from the pool
 *   - V4: bytes32 pool id — we need PoolManager.Initialize logs to recover
 *         (currency0, currency1)
 *   - Curve: int128 coin indices — we need coins(i) from the pool
 *   - Balancer: token addresses already in the event (no resolve needed)
 *
 * All resolvers cache. The cache lives for the lifetime of the process,
 * which is fine for short scans; for long-running scanners callers can
 * reset() the maps.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  parseAbi,
  parseAbiItem,
  toEventSelector,
} from "viem";
import type { PartialSwap } from "./events.js";

interface TokenPair {
  /** Always lowercased. */
  token0: string;
  token1: string;
}

const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function coins(uint256) view returns (address)",
]);

const V4_INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);
const V4_INITIALIZE_TOPIC = toEventSelector(V4_INITIALIZE_EVENT);

/**
 * Per-chain caches. Keyed by `${chain}:${id}` so multi-chain scanners
 * don't collide.
 */
const v2v3Cache = new Map<string, TokenPair>();
const v4Cache = new Map<string, TokenPair>();
const curveCoinsCache = new Map<string, string[]>();

function key(chain: string, id: string): string {
  return `${chain}:${id.toLowerCase()}`;
}

export function clearResolverCaches(): void {
  v2v3Cache.clear();
  v4Cache.clear();
  curveCoinsCache.clear();
}

/**
 * Resolve V2/V3 pool tokens via token0()/token1() calls. Combined into a
 * single multicall-ish pair; viem will batch if the transport supports it.
 */
async function resolveV2V3Pool(
  client: PublicClient,
  chain: string,
  pool: Address
): Promise<TokenPair | null> {
  const k = key(chain, pool);
  const cached = v2v3Cache.get(k);
  if (cached) return cached;
  try {
    const [t0, t1] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    ]);
    const pair: TokenPair = {
      token0: (t0 as Address).toLowerCase(),
      token1: (t1 as Address).toLowerCase(),
    };
    v2v3Cache.set(k, pair);
    return pair;
  } catch {
    return null;
  }
}

/**
 * Resolve a V4 pool id by searching PoolManager.Initialize events. Because
 * Initialize fires once per pool *ever*, we don't know which block emitted
 * it. Strategy: search the *current* block first (in case it's a brand-new
 * pool initialized just before the swap), then a widening backward window.
 *
 * Performance note: this can be slow for fresh-pool lookups on RPC providers
 * with eth_getLogs range limits. We chunk to 10k blocks per call.
 */
async function resolveV4Pool(
  client: PublicClient,
  chain: string,
  poolManager: Address,
  poolId: Hex,
  searchUpToBlock: bigint
): Promise<TokenPair | null> {
  const k = key(chain, poolId);
  const cached = v4Cache.get(k);
  if (cached) return cached;

  const CHUNK = 10_000n;
  const MAX_LOOKBACK = 1_000_000n; // ~23 days on Base
  let to = searchUpToBlock;
  let scanned = 0n;
  while (scanned < MAX_LOOKBACK) {
    const from = to > CHUNK ? to - CHUNK : 0n;
    try {
      const logs = await client.getLogs({
        address: poolManager,
        event: V4_INITIALIZE_EVENT,
        args: { id: poolId },
        fromBlock: from,
        toBlock: to,
      });
      if (logs.length > 0) {
        const ev = logs[0]!;
        // viem returns decoded args on event-typed getLogs
        const a = (ev as any).args as {
          id: Hex; currency0: Address; currency1: Address;
        };
        const pair: TokenPair = {
          token0: a.currency0.toLowerCase(),
          token1: a.currency1.toLowerCase(),
        };
        v4Cache.set(k, pair);
        return pair;
      }
    } catch {
      // RPC range error etc. — try a smaller chunk on next loop
    }
    if (from === 0n) break;
    to = from - 1n;
    scanned += CHUNK;
  }
  return null;
}

async function resolveCurveCoin(
  client: PublicClient,
  chain: string,
  pool: Address,
  idx: number
): Promise<string | null> {
  const k = key(chain, pool);
  let list = curveCoinsCache.get(k);
  if (!list) {
    list = [];
    curveCoinsCache.set(k, list);
  }
  if (list[idx]) return list[idx]!;
  try {
    const addr = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "coins",
      args: [BigInt(idx)],
    })) as Address;
    list[idx] = addr.toLowerCase();
    return list[idx]!;
  } catch {
    return null;
  }
}

/**
 * Fill in tokenIn/tokenOut on a PartialSwap. Returns a fully-resolved
 * NormalizedSwap, or null if resolution failed (we drop unresolvable swaps
 * because they can't participate in cycle detection).
 */
export async function resolveSwap(
  client: PublicClient,
  chain: string,
  poolManager: Address | undefined,
  swap: PartialSwap,
  searchUpToBlock: bigint
): Promise<{ tokenIn: string; tokenOut: string } | null> {
  switch (swap.hint.kind) {
    case "balancer":
      return {
        tokenIn: swap.hint.tokenIn.toLowerCase(),
        tokenOut: swap.hint.tokenOut.toLowerCase(),
      };
    case "v2v3": {
      const pair = await resolveV2V3Pool(client, chain, swap.venue);
      if (!pair) return null;
      const zeroForOne = swap.direction === "zeroForOne";
      return {
        tokenIn: zeroForOne ? pair.token0 : pair.token1,
        tokenOut: zeroForOne ? pair.token1 : pair.token0,
      };
    }
    case "v4": {
      if (!poolManager) return null;
      const pair = await resolveV4Pool(client, chain, poolManager, swap.hint.poolId, searchUpToBlock);
      if (!pair) return null;
      const zeroForOne = swap.direction === "zeroForOne";
      return {
        tokenIn: zeroForOne ? pair.token0 : pair.token1,
        tokenOut: zeroForOne ? pair.token1 : pair.token0,
      };
    }
    case "curve": {
      const [tIn, tOut] = await Promise.all([
        resolveCurveCoin(client, chain, swap.venue, swap.hint.soldId),
        resolveCurveCoin(client, chain, swap.venue, swap.hint.boughtId),
      ]);
      if (!tIn || !tOut) return null;
      return { tokenIn: tIn, tokenOut: tOut };
    }
  }
}

/** Bulk resolve, preserving order. Drops any swap that doesn't resolve. */
export async function resolveSwaps(
  client: PublicClient,
  chain: string,
  poolManager: Address | undefined,
  swaps: PartialSwap[],
  searchUpToBlock: bigint
): Promise<Array<PartialSwap & { tokenIn: string; tokenOut: string }>> {
  const resolved = await Promise.all(
    swaps.map(async (s) => {
      const tokens = await resolveSwap(client, chain, poolManager, s, searchUpToBlock);
      return tokens ? { ...s, ...tokens } : null;
    })
  );
  return resolved.filter((r): r is PartialSwap & { tokenIn: string; tokenOut: string } => r !== null);
}

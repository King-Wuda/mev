/**
 * Normalized swap events across DEX families.
 *
 * Each family emits its own Swap shape:
 *   - V2 (Uniswap V2 / Aero V2 / Sushi V2)
 *     event Swap(address indexed sender, uint amount0In, uint amount1In,
 *                uint amount0Out, uint amount1Out, address indexed to)
 *   - V3 (Uniswap V3, Pancake V3, Aero slipstream, etc.)
 *     event Swap(address indexed sender, address indexed recipient,
 *                int256 amount0, int256 amount1, uint160 sqrtPriceX96,
 *                uint128 liquidity, int24 tick)
 *   - V4 PoolManager
 *     event Swap(bytes32 indexed id, address indexed sender,
 *                int128 amount0, int128 amount1, uint160 sqrtPriceX96,
 *                uint128 liquidity, int24 tick, uint24 fee)
 *   - Curve StableSwap
 *     event TokenExchange(address indexed buyer, int128 sold_id,
 *                         uint256 tokens_sold, int128 bought_id,
 *                         uint256 tokens_bought)
 *   - Balancer V2 Vault
 *     event Swap(bytes32 indexed poolId, address indexed tokenIn,
 *                address indexed tokenOut, uint256 amountIn,
 *                uint256 amountOut)
 *
 * Reverse-engineering an arb means projecting all of these into one shape:
 * `(dex, venue, tokenIn, amountIn, tokenOut, amountOut)`. From there the
 * cycle search is dex-agnostic.
 */

import {
  type Address,
  type Hex,
  type Log,
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
} from "viem";

export type DexFamily = "v2" | "v3" | "v4" | "curve" | "balancer";

export interface NormalizedSwap {
  family: DexFamily;
  /** Pool address for V2/V3/Curve, Vault address for Balancer, PoolManager for V4. */
  venue: Address;
  /**
   * Stable identifier for the *pool* itself:
   *   - V2/V3/Curve: the pool address (lowercased)
   *   - V4: the bytes32 pool id
   *   - Balancer: the bytes32 poolId
   * Used as a graph-edge label so two swaps on the same pool collapse.
   */
  poolId: string;
  /** Resolved token addresses (lowercased). May be empty string if not yet resolved. */
  tokenIn: string;
  tokenOut: string;
  /** Raw token amounts (always positive). */
  amountIn: bigint;
  amountOut: bigint;
  /** Counterparty that received tokenOut from the pool. */
  recipient: Address;
  /** Tx-internal ordering (log index). */
  logIndex: number;
  /** Original log for downstream callers that want raw access. */
  raw: Log;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event signatures and topic hashes
// ─────────────────────────────────────────────────────────────────────────────

export const V2_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);
export const V3_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);
export const V4_SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);
export const CURVE_EXCHANGE_EVENT = parseAbiItem(
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)"
);
export const BAL_SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)"
);

export const V2_SWAP_TOPIC = toEventSelector(V2_SWAP_EVENT);
export const V3_SWAP_TOPIC = toEventSelector(V3_SWAP_EVENT);
export const V4_SWAP_TOPIC = toEventSelector(V4_SWAP_EVENT);
export const CURVE_EXCHANGE_TOPIC = toEventSelector(CURVE_EXCHANGE_EVENT);
export const BAL_SWAP_TOPIC = toEventSelector(BAL_SWAP_EVENT);

/**
 * Canonical Balancer V2 Vault addresses (same on most chains, but kept here
 * so callers don't hard-code them). PoolManager is per-chain in dexes.ts.
 */
export const BALANCER_VAULT_BY_CHAIN: Record<string, Address> = {
  base: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  ethereum: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-family decoders. They return a *partial* NormalizedSwap missing only
// the tokenIn / tokenOut addresses, which resolve.ts fills in.
// ─────────────────────────────────────────────────────────────────────────────

export interface PartialSwap extends Omit<NormalizedSwap, "tokenIn" | "tokenOut"> {
  /**
   * Family-specific hint the resolver needs:
   *   - v2/v3: nothing extra
   *   - v4: bytes32 pool id (also in poolId)
   *   - curve: { soldId, boughtId }
   *   - balancer: { tokenIn, tokenOut } addresses (already known)
   */
  hint:
    | { kind: "v2v3" }
    | { kind: "v4"; poolId: Hex }
    | { kind: "curve"; soldId: number; boughtId: number }
    | { kind: "balancer"; tokenIn: Address; tokenOut: Address };
  /**
   * For V2/V3 swaps we know the *direction* but not the addresses — we know
   * which is "token0" and "token1" in the pool's natural ordering. The
   * resolver maps this to real addresses.
   */
  direction?: "zeroForOne" | "oneForZero";
}

export function decodeOneSwap(log: Log): PartialSwap | null {
  const t0 = log.topics[0];
  if (!t0) return null;
  const venue = log.address as Address;
  const logIndex = Number(log.logIndex ?? 0);

  switch (t0) {
    case V2_SWAP_TOPIC:
      return decodeV2(log, venue, logIndex);
    case V3_SWAP_TOPIC:
      return decodeV3(log, venue, logIndex);
    case V4_SWAP_TOPIC:
      return decodeV4(log, venue, logIndex);
    case CURVE_EXCHANGE_TOPIC:
      return decodeCurve(log, venue, logIndex);
    case BAL_SWAP_TOPIC:
      return decodeBalancer(log, venue, logIndex);
    default:
      return null;
  }
}

function decodeV2(log: Log, venue: Address, logIndex: number): PartialSwap | null {
  try {
    const dec = decodeEventLog({ abi: [V2_SWAP_EVENT], data: log.data, topics: log.topics });
    const a = dec.args as unknown as {
      sender: Address; amount0In: bigint; amount1In: bigint;
      amount0Out: bigint; amount1Out: bigint; to: Address;
    };
    // V2 emits both ins and outs; the non-zero pair tells direction.
    const zeroIn = a.amount0In > 0n;
    const direction = zeroIn ? "zeroForOne" : "oneForZero";
    const amountIn = zeroIn ? a.amount0In : a.amount1In;
    const amountOut = zeroIn ? a.amount1Out : a.amount0Out;
    return {
      family: "v2",
      venue,
      poolId: venue.toLowerCase(),
      amountIn, amountOut,
      recipient: a.to,
      logIndex,
      raw: log,
      hint: { kind: "v2v3" },
      direction,
    };
  } catch { return null; }
}

function decodeV3(log: Log, venue: Address, logIndex: number): PartialSwap | null {
  try {
    const dec = decodeEventLog({ abi: [V3_SWAP_EVENT], data: log.data, topics: log.topics });
    const a = dec.args as unknown as {
      sender: Address; recipient: Address;
      amount0: bigint; amount1: bigint;
    };
    // V3 amount signs: positive = pool received that token; negative = pool sent it.
    // So amount0 > 0 ⇒ token0 in (zeroForOne).
    const zeroIn = a.amount0 > 0n;
    const direction = zeroIn ? "zeroForOne" : "oneForZero";
    const amountIn = zeroIn ? a.amount0 : a.amount1;
    const amountOut = zeroIn ? -a.amount1 : -a.amount0;
    return {
      family: "v3",
      venue,
      poolId: venue.toLowerCase(),
      amountIn, amountOut,
      recipient: a.recipient,
      logIndex,
      raw: log,
      hint: { kind: "v2v3" },
      direction,
    };
  } catch { return null; }
}

function decodeV4(log: Log, venue: Address, logIndex: number): PartialSwap | null {
  try {
    const dec = decodeEventLog({ abi: [V4_SWAP_EVENT], data: log.data, topics: log.topics });
    const a = dec.args as unknown as {
      id: Hex; sender: Address;
      amount0: bigint; amount1: bigint;
    };
    // V4 sign convention is the *opposite* of V3's (positive = pool sent it).
    // See PoolManager's _swap: deltas are returned from the pool's perspective.
    const zeroOut = a.amount0 > 0n;
    const direction = zeroOut ? "oneForZero" : "zeroForOne";
    const amountIn = zeroOut ? a.amount1 : a.amount0;
    const amountOut = zeroOut ? a.amount0 : -a.amount1 < 0n ? -a.amount1 : a.amount1;
    // Clean up signs (above expression handles V4's negate-input convention).
    const absIn = amountIn < 0n ? -amountIn : amountIn;
    const absOut = amountOut < 0n ? -amountOut : amountOut;
    return {
      family: "v4",
      venue,
      poolId: a.id.toLowerCase(),
      amountIn: absIn, amountOut: absOut,
      recipient: a.sender, // V4 doesn't emit recipient at the event level
      logIndex,
      raw: log,
      hint: { kind: "v4", poolId: a.id },
      direction,
    };
  } catch { return null; }
}

function decodeCurve(log: Log, venue: Address, logIndex: number): PartialSwap | null {
  try {
    const dec = decodeEventLog({ abi: [CURVE_EXCHANGE_EVENT], data: log.data, topics: log.topics });
    const a = dec.args as unknown as {
      buyer: Address; sold_id: bigint; tokens_sold: bigint;
      bought_id: bigint; tokens_bought: bigint;
    };
    return {
      family: "curve",
      venue,
      poolId: venue.toLowerCase(),
      amountIn: a.tokens_sold, amountOut: a.tokens_bought,
      recipient: a.buyer,
      logIndex,
      raw: log,
      hint: { kind: "curve", soldId: Number(a.sold_id), boughtId: Number(a.bought_id) },
    };
  } catch { return null; }
}

function decodeBalancer(log: Log, venue: Address, logIndex: number): PartialSwap | null {
  try {
    const dec = decodeEventLog({ abi: [BAL_SWAP_EVENT], data: log.data, topics: log.topics });
    const a = dec.args as unknown as {
      poolId: Hex; tokenIn: Address; tokenOut: Address;
      amountIn: bigint; amountOut: bigint;
    };
    return {
      family: "balancer",
      venue,
      poolId: a.poolId.toLowerCase(),
      amountIn: a.amountIn, amountOut: a.amountOut,
      recipient: venue,
      logIndex,
      raw: log,
      hint: { kind: "balancer", tokenIn: a.tokenIn, tokenOut: a.tokenOut },
    };
  } catch { return null; }
}

/** Fast prefilter: does this topic look like any of our swap events? */
export const ALL_SWAP_TOPICS = new Set<Hex>([
  V2_SWAP_TOPIC,
  V3_SWAP_TOPIC,
  V4_SWAP_TOPIC,
  CURVE_EXCHANGE_TOPIC,
  BAL_SWAP_TOPIC,
]);

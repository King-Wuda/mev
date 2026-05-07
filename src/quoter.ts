import { encodePacked, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { ChainKey } from "./chains.js";
import type { TokenConfig } from "./dexes.js";
import type { TriangleOpportunity } from "./triangle.js";

/**
 * Uniswap V3 QuoterV2 — simulates a swap path on-chain via eth_call,
 * returning the actual amountOut after slippage and fees. This converts
 * our spot-price-derived "theoretical" profit into an executable estimate.
 *
 * We only quote multi-hop routes (i.e. triangles) since that's where
 * the spot-price approximation diverges most from reality.
 */
const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

// Canonical Uniswap V3 QuoterV2 deployments.
export const QUOTER_ADDRESSES: Partial<Record<ChainKey, Address>> = {
  base: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
};

/**
 * Encode a Uniswap V3 multi-hop path as bytes:
 *   tokenA (20) | feeAB (3) | tokenB (20) | feeBC (3) | tokenC (20) ...
 */
function encodeV3Path(tokens: Address[], fees: number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("encodeV3Path: tokens.length must be fees.length + 1");
  }
  // Build types/values lists for encodePacked.
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push("address");
    values.push(tokens[i]!);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]!);
    }
  }
  return encodePacked(types, values as never);
}

export interface QuotedTriangle {
  triangle: TriangleOpportunity;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  /** Exact gross profit in the anchor token, post-slippage, post-fee. */
  realizedBps: number;
  /** Theoretical bps minus realized bps — measures how off the spot model was. */
  slippageBps: number;
  /** True if this triangle's path goes only through Uniswap V3 (V4 not quotable here). */
  quotable: boolean;
}

/**
 * Run QuoterV2 against a triangle. Only V3-only paths are quotable; we skip
 * V4 hops since QuoterV2 doesn't know about V4 pools.
 *
 * Returns null when there's no quoter for this chain. Returns
 * `{ quotable: false }` when the path includes a V4 hop. Returns realized
 * numbers when the simulation succeeded.
 */
export async function quoteTriangle(
  client: PublicClient,
  chainKey: ChainKey,
  triangle: TriangleOpportunity,
  anchorToken: TokenConfig,
  symbolToToken: Map<string, TokenConfig>,
  amountInUsd: number
): Promise<QuotedTriangle | null> {
  const quoter = QUOTER_ADDRESSES[chainKey];
  if (!quoter) return null;

  if (triangle.hops.some((h) => h.dex === "Uniswap V4")) {
    return { triangle, amountInRaw: 0n, amountOutRaw: 0n, realizedBps: 0, slippageBps: 0, quotable: false };
  }

  // Build path: hop0.from → hop0.to → hop1.to → hop2.to(=anchor)
  const tokenSyms = [
    triangle.hops[0]!.from,
    triangle.hops[0]!.to,
    triangle.hops[1]!.to,
    triangle.hops[2]!.to,
  ];
  const tokens: Address[] = [];
  for (const sym of tokenSyms) {
    const t = symbolToToken.get(sym);
    if (!t) return null;
    tokens.push(t.address);
  }
  const fees = triangle.hops.map((h) => h.fee);

  const path = encodeV3Path(tokens, fees);
  // amountIn in anchor's raw units
  const amountInTokens = amountInUsd / (anchorToken.usdHint || 1);
  const amountInRaw = BigInt(Math.floor(amountInTokens * 10 ** anchorToken.decimals));

  try {
    // QuoterV2 is callable as a static call (eth_call), not a regular view —
    // viem's simulateContract handles this transparently.
    const { result } = await client.simulateContract({
      address: quoter,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [path, amountInRaw],
    });
    const amountOutRaw = result[0] as bigint;
    const profitRaw = amountOutRaw - amountInRaw;
    const realizedBps =
      Number((profitRaw * 10_000_000n) / amountInRaw) / 1000; // 4-decimal bps
    const slippageBps = triangle.grossBps - realizedBps;
    return {
      triangle,
      amountInRaw,
      amountOutRaw,
      realizedBps,
      slippageBps,
      quotable: true,
    };
  } catch {
    return null;
  }
}

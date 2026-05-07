import {
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { CHAINS, type ChainKey } from "./chains.js";
import { TOKENS, V3_FACTORIES, V4_CONFIGS, type TokenConfig } from "./dexes.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

// Multicall3 is deployed at this canonical address on virtually every EVM chain.
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const FACTORY_ABI = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

// V4 StateView: read-only access to PoolManager state. Pool key is bytes32.
const V4_STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

const ZERO_HOOKS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Compute Uniswap V4 pool ID:
 *   poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 *
 * Currencies must be address-sorted ascending (V4 enforces currency0 < currency1).
 */
export function computeV4PoolId(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address = ZERO_HOOKS
): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [currency0, currency1, fee, tickSpacing, hooks]
  );
  return keccak256(encoded);
}

export interface DiscoveredPool {
  dex: string;
  fee: number;
  /** V3 pool address, or V4 StateView contract for V4 pools. */
  address: Address;
  token0: TokenConfig;
  token1: TokenConfig;
  /** Set only for V4 pools — used to route reads through StateView. */
  v4PoolId?: Hex;
}

export interface PoolState {
  pool: DiscoveredPool;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** Price as token1 per token0, decimal-adjusted (human units). */
  price: number;
}

export interface Opportunity {
  chain: string;
  pair: string;
  baseSymbol: string;
  quoteSymbol: string;
  buyDex: string;
  buyFee: number;
  sellDex: string;
  sellFee: number;
  buyPrice: number;
  sellPrice: number;
  /** Raw price spread between the two pools, in bps. */
  spreadBps: number;
  /** Spread minus the sum of both pool fees. Positive => potentially profitable. */
  netSpreadBps: number;
  /** Profit on $notional notional, gross of slippage and gas, after fees. */
  netProfitUsd: number;
}

export function makeClient(chainKey: ChainKey): PublicClient {
  const cfg = CHAINS[chainKey];
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
}

/**
 * Discover pools by querying each factory's getPool() for every token
 * pair × fee tier. Pools that don't exist return the zero address.
 */
export async function discoverPools(
  client: PublicClient,
  chainKey: ChainKey
): Promise<DiscoveredPool[]> {
  const tokens = TOKENS[chainKey];
  const factories = V3_FACTORIES[chainKey];
  if (tokens.length < 2 || factories.length === 0) return [];

  type CallMeta = { dex: string; fee: number; tA: TokenConfig; tB: TokenConfig };
  const contracts: Array<{
    address: Address;
    abi: typeof FACTORY_ABI;
    functionName: "getPool";
    args: readonly [Address, Address, number];
  }> = [];
  const meta: CallMeta[] = [];

  for (const factory of factories) {
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const tA = tokens[i]!;
        const tB = tokens[j]!;
        for (const fee of factory.feeTiers) {
          contracts.push({
            address: factory.factory,
            abi: FACTORY_ABI,
            functionName: "getPool",
            args: [tA.address, tB.address, fee],
          });
          meta.push({ dex: factory.name, fee, tA, tB });
        }
      }
    }
  }

  // Use Multicall3 to batch all factory.getPool() probes in one RPC call.
  // Without this, 1k+ individual readContract calls hammer the public RPC.
  const results = await client.multicall({ contracts, allowFailure: true });

  const pools: DiscoveredPool[] = [];
  for (let i = 0; i < contracts.length; i++) {
    const r = results[i];
    const m = meta[i]!;
    if (!r || r.status !== "success") continue;
    const addr = r.result as Address;
    if (addr === ZERO) continue;
    const [t0, t1] =
      m.tA.address.toLowerCase() < m.tB.address.toLowerCase()
        ? [m.tA, m.tB]
        : [m.tB, m.tA];
    pools.push({
      dex: m.dex,
      fee: m.fee,
      address: addr,
      token0: t0,
      token1: t1,
    });
  }
  return pools;
}

/**
 * Convert sqrtPriceX96 to a human-readable price (token1/token0).
 *
 * Raw ratio = (sqrtPriceX96 / 2^96)^2 expresses token1_units per token0_units.
 * Convert to "human" by adjusting for decimals: ratio * 10^(t0Dec - t1Dec).
 *
 * Note: sqrtPriceX96 is up to 160 bits; squaring overflows JS Number for
 * extreme prices. We split the math to keep precision in the typical range.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  if (sqrtPriceX96 === 0n) return 0;
  const Q96 = 2n ** 96n;
  // Use BigInt division to keep precision, then convert.
  // numerator / denominator = (sqrtPriceX96^2 * 10^t0Dec) / (Q96^2 * 10^t1Dec)
  const num = sqrtPriceX96 * sqrtPriceX96;
  const den = Q96 * Q96;
  // Scale to a fixed precision (1e18) before converting to Number.
  const scaled = (num * 10n ** 36n) / den;
  const ratio = Number(scaled) / 1e36;
  return ratio * Math.pow(10, token0Decimals - token1Decimals);
}

/**
 * Discover V4 pools by probing PoolManager via StateView. Since V4 is a
 * singleton (no factory), we enumerate (token0, token1) × (fee, tickSpacing)
 * combinations, compute the pool ID, and call getSlot0. Initialized pools
 * return non-zero sqrtPriceX96.
 *
 * Note: this only finds vanilla pools (hooks=zero). Hooked pools require
 * indexing PoolManager.Initialize events — out of scope for v1.
 */
export async function discoverV4Pools(
  client: PublicClient,
  chainKey: ChainKey
): Promise<DiscoveredPool[]> {
  const tokens = TOKENS[chainKey];
  const v4 = V4_CONFIGS[chainKey];
  if (!v4 || tokens.length < 2) return [];

  type Candidate = {
    poolId: Hex;
    fee: number;
    tickSpacing: number;
    t0: TokenConfig;
    t1: TokenConfig;
  };
  const candidates: Candidate[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const tA = tokens[i]!;
      const tB = tokens[j]!;
      // V4 requires currency0 < currency1 by address
      const [t0, t1] =
        tA.address.toLowerCase() < tB.address.toLowerCase() ? [tA, tB] : [tB, tA];
      for (const { fee, tickSpacing } of v4.feeTickSpacings) {
        const poolId = computeV4PoolId(t0.address, t1.address, fee, tickSpacing);
        candidates.push({ poolId, fee, tickSpacing, t0, t1 });
      }
    }
  }

  // Batch-probe via multicall: one getSlot0 per candidate.
  const contracts = candidates.map((c) => ({
    address: v4.stateView,
    abi: V4_STATE_VIEW_ABI,
    functionName: "getSlot0" as const,
    args: [c.poolId] as const,
  }));

  const results = await client.multicall({ contracts, allowFailure: true });

  const pools: DiscoveredPool[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = results[i];
    if (!r || r.status !== "success") continue;
    const tuple = r.result as readonly [bigint, number, number, number];
    if (tuple[0] === 0n) continue; // uninitialized
    const c = candidates[i]!;
    pools.push({
      dex: v4.name,
      fee: c.fee,
      // The "address" field is overloaded: for V4 it's the StateView address;
      // we route reads through the same contract using the pool ID.
      address: v4.stateView,
      token0: c.t0,
      token1: c.t1,
      // Track the V4 pool id so readPoolStates can route correctly.
      v4PoolId: c.poolId,
    });
  }
  return pools;
}

export async function readPoolStates(
  client: PublicClient,
  pools: DiscoveredPool[]
): Promise<PoolState[]> {
  if (pools.length === 0) return [];

  // Build per-pool calls. V4 pools route through StateView with the poolId arg;
  // V3 pools call slot0() / liquidity() on the pool contract directly.
  const contracts: Array<{
    address: Address;
    abi: any;
    functionName: string;
    args?: readonly unknown[];
  }> = [];
  for (const p of pools) {
    if (p.v4PoolId) {
      contracts.push({
        address: p.address,
        abi: V4_STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: [p.v4PoolId],
      });
      contracts.push({
        address: p.address,
        abi: V4_STATE_VIEW_ABI,
        functionName: "getLiquidity",
        args: [p.v4PoolId],
      });
    } else {
      contracts.push({ address: p.address, abi: POOL_ABI, functionName: "slot0" });
      contracts.push({ address: p.address, abi: POOL_ABI, functionName: "liquidity" });
    }
  }

  const results = await client.multicall({
    contracts: contracts as any,
    allowFailure: true,
  });

  const out: PoolState[] = [];
  for (let i = 0; i < pools.length; i++) {
    const slot0 = results[i * 2];
    const liq = results[i * 2 + 1];
    if (!slot0 || !liq || slot0.status !== "success" || liq.status !== "success") {
      continue;
    }
    const pool = pools[i]!;
    let sqrtPriceX96: bigint;
    if (pool.v4PoolId) {
      // V4: getSlot0 returns (sqrtPriceX96, tick, protocolFee, lpFee)
      const tuple = slot0.result as readonly [bigint, number, number, number];
      sqrtPriceX96 = tuple[0];
    } else {
      // V3: slot0 returns (sqrtPriceX96, tick, ..., unlocked)
      const tuple = slot0.result as readonly [
        bigint, number, number, number, number, number, boolean
      ];
      sqrtPriceX96 = tuple[0];
    }
    if (sqrtPriceX96 === 0n) continue;
    const liquidity = liq.result as bigint;

    const price = priceFromSqrtX96(
      sqrtPriceX96,
      pool.token0.decimals,
      pool.token1.decimals
    );
    out.push({ pool, sqrtPriceX96, liquidity, price });
  }
  return out;
}

/**
 * Group pools by token-pair, find the cheapest and most expensive pool, and
 * report any spread above `minSpreadBps`. `grossProfitUsd` is for a $1k
 * notional trade and ignores slippage, fees, and gas — it's an *upper bound*.
 */
export function findOpportunities(
  states: PoolState[],
  chainName: string,
  minSpreadBps: number,
  notionalUsd: number,
  minLiquidity: bigint
): Opportunity[] {
  const byPair = new Map<string, PoolState[]>();
  for (const s of states) {
    if (s.liquidity < minLiquidity) continue;
    const key = `${s.pool.token0.address}-${s.pool.token1.address}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(s);
  }

  const opps: Opportunity[] = [];
  for (const pools of byPair.values()) {
    if (pools.length < 2) continue;
    pools.sort((a, b) => a.price - b.price);
    const cheap = pools[0]!;
    const dear = pools[pools.length - 1]!;
    if (cheap.price <= 0 || dear.price <= 0) continue;
    const spreadBps = ((dear.price - cheap.price) / cheap.price) * 10_000;
    if (spreadBps < minSpreadBps) continue;

    // Fee tier is in hundredths of a bp (1e-6), so 3000 = 30bps = 0.3%.
    const buyFeeBps = cheap.pool.fee / 100;
    const sellFeeBps = dear.pool.fee / 100;
    const netSpreadBps = spreadBps - buyFeeBps - sellFeeBps;
    const netProfitUsd = (notionalUsd * netSpreadBps) / 10_000;

    opps.push({
      chain: chainName,
      pair: `${cheap.pool.token0.symbol}/${cheap.pool.token1.symbol}`,
      baseSymbol: cheap.pool.token0.symbol,
      quoteSymbol: cheap.pool.token1.symbol,
      buyDex: cheap.pool.dex,
      buyFee: cheap.pool.fee,
      sellDex: dear.pool.dex,
      sellFee: dear.pool.fee,
      buyPrice: cheap.price,
      sellPrice: dear.price,
      spreadBps,
      netSpreadBps,
      netProfitUsd,
    });
  }
  // Sort: best net first (negative-net is sorted to the end)
  opps.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
  return opps;
}

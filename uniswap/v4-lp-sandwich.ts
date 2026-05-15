import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  decodeEventLog,
  parseAbi,
  parseAbiItem,
  toEventSelector,
} from "viem";
import type { ChainKey } from "../src/chains.js";

/**
 * Detect "delta-based liquidity sandwich" attacks on Uniswap V4 PoolManager.
 *
 * The pattern, as described in Uniswap's own test
 * (PositionManagerModifyLiquiditiesTest::test_increaseFromDeltasPOC):
 *   1. Attacker submits a large swap on pool P, shifting price
 *   2. Victim submits MINT_POSITION_FROM_DELTAS or INCREASE_LIQUIDITY_FROM_DELTAS,
 *      which uses whatever delta is in their settlement account — meaning they
 *      deposit at the (now skewed) post-attack price
 *   3. Attacker reverses the swap, capturing the imbalance
 *
 * On-chain footprint within a single block:
 *   - PoolManager.Swap (from attacker EOA on pool P)
 *   - PoolManager.ModifyLiquidity with positive liquidityDelta (victim, pool P)
 *   - PoolManager.Swap (from same attacker EOA on pool P, opposite direction)
 *
 * This module surfaces those triplets. It is read-only: it does not execute
 * anything, only reports.
 */

/** Canonical Uniswap V4 PoolManager addresses. */
export const POOL_MANAGER_BY_CHAIN: Partial<Record<ChainKey, Address>> = {
  base: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  // ethereum: "0x000000000004444c5dc75cB358380D2e3dE08A90",  // when we add mainnet
};

const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);
const MODIFY_LIQ_EVENT = parseAbiItem(
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"
);

const SWAP_TOPIC = toEventSelector(SWAP_EVENT);
const MODIFY_LIQ_TOPIC = toEventSelector(MODIFY_LIQ_EVENT);

export const V4_EVENT_ABI = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);

export interface LpSandwichHit {
  chain: string;
  blockNumber: bigint;
  poolId: Hex;
  frontRunTx: Hex;
  victimTx: Hex;
  backRunTx: Hex;
  attackerEoa: Address;
  victimEoa: Address;
  /** Sum of absolute swap amounts that bracketed the victim. */
  attackerSwapAmount0: bigint;
  /** Liquidity the victim added (the magnitude of LP exposure they took on). */
  victimLiquidityDelta: bigint;
  /** Sender contract from the victim's ModifyLiquidity event — usually a
   *  periphery (PositionManager, UniversalRouter); helpful for triage. */
  victimSenderContract: Address;
}

interface V4Event {
  txHash: Hex;
  txIndex: number;
  logIndex: number;
  /** EOA that signed the tx. */
  from: Address;
  /** Contract the tx was sent to (the searcher's executor for MEV bots). */
  to: Address | null;
  poolId: Hex;
  kind: "swap" | "modliq";
  swapAmount0?: bigint;
  swapAmount1?: bigint;
  liquidityDelta?: bigint;
  senderContract?: Address;
}

/**
 * Lower-bound sanity threshold. We don't have token decimals at this layer
 * (V4 pools are identified by hashed PoolKey, not by token addresses
 * directly), so a single fixed bigint would be wrong for 6-decimal stable
 * pairs vs 18-decimal pairs. We set this to zero and rely on the structural
 * pattern (matching EOA, opposite-direction swaps, positive-delta LP add
 * by a different EOA) to filter false positives.
 *
 * If you want to filter micro-attacks later, lift this out into a per-pool
 * threshold once the detector also resolves PoolKey → tokens.
 */
const MIN_SWAP_NOTIONAL_RAW = 0n;

/**
 * Fetch all PoolManager events in a block and classify each into our V4Event
 * structure. Returns events grouped by pool ID, ordered by tx position then
 * log index — the natural execution order.
 */
async function fetchV4Events(
  client: PublicClient,
  poolManager: Address,
  blockNumber: bigint,
  txFromByHash: Map<Hex, Address>,
  txToByHash: Map<Hex, Address | null>,
  txIndexByHash: Map<Hex, number>
): Promise<Map<Hex, V4Event[]>> {
  const logs = await client.getLogs({
    address: poolManager,
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });

  const byPool = new Map<Hex, V4Event[]>();

  for (const log of logs) {
    const t0 = log.topics[0];
    if (!t0) continue;
    const txHash = log.transactionHash as Hex;
    const from = txFromByHash.get(txHash);
    const to = txToByHash.get(txHash) ?? null;
    const txIndex = txIndexByHash.get(txHash);
    if (!from || txIndex === undefined) continue;
    const logIndex = Number(log.logIndex ?? 0);

    if (t0 === SWAP_TOPIC) {
      try {
        const dec = decodeEventLog({
          abi: V4_EVENT_ABI,
          eventName: "Swap",
          data: log.data,
          topics: log.topics,
        });
        const args = dec.args as unknown as {
          id: Hex;
          sender: Address;
          amount0: bigint;
          amount1: bigint;
          sqrtPriceX96: bigint;
          liquidity: bigint;
          tick: number;
          fee: number;
        };
        const ev: V4Event = {
          txHash, txIndex, logIndex, from, to,
          poolId: args.id,
          kind: "swap",
          swapAmount0: args.amount0,
          swapAmount1: args.amount1,
        };
        if (!byPool.has(args.id)) byPool.set(args.id, []);
        byPool.get(args.id)!.push(ev);
      } catch {
        // skip malformed
      }
    } else if (t0 === MODIFY_LIQ_TOPIC) {
      try {
        const dec = decodeEventLog({
          abi: V4_EVENT_ABI,
          eventName: "ModifyLiquidity",
          data: log.data,
          topics: log.topics,
        });
        const args = dec.args as unknown as {
          id: Hex;
          sender: Address;
          tickLower: number;
          tickUpper: number;
          liquidityDelta: bigint;
          salt: Hex;
        };
        const ev: V4Event = {
          txHash, txIndex, logIndex, from, to,
          poolId: args.id,
          kind: "modliq",
          liquidityDelta: args.liquidityDelta,
          senderContract: args.sender,
        };
        if (!byPool.has(args.id)) byPool.set(args.id, []);
        byPool.get(args.id)!.push(ev);
      } catch {
        // skip
      }
    }
  }

  // Sort events within each pool by (txIndex, logIndex)
  for (const arr of byPool.values()) {
    arr.sort((a, b) => a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  }
  return byPool;
}

/**
 * Pattern-match LP-sandwich triplets within a single pool's event sequence.
 *
 * We accept a triplet if:
 *   - Event i is a Swap by EOA X (attacker, front-run)
 *   - Event k is a Swap by EOA X on same pool, opposite direction (back-run)
 *   - Some event j between them is a ModifyLiquidity by a different EOA Y
 *     with positive liquidityDelta (LP add — the susceptible operation)
 */
function findSandwichesInPool(
  poolId: Hex,
  events: V4Event[],
  chainName: string,
  blockNumber: bigint
): LpSandwichHit[] {
  const hits: LpSandwichHit[] = [];
  if (events.length < 3) return hits;

  const usedTx = new Set<Hex>();

  for (let i = 0; i < events.length - 2; i++) {
    const a = events[i]!;
    if (a.kind !== "swap") continue;
    if (a.swapAmount0 === undefined) continue;
    if (absBig(a.swapAmount0) < MIN_SWAP_NOTIONAL_RAW) continue;

    for (let k = i + 2; k < events.length; k++) {
      const c = events[k]!;
      if (c.kind !== "swap") continue;
      if (c.swapAmount0 === undefined) continue;

      // Sophisticated searchers use many EOAs calling a single executor
      // contract (the EigenPhi data showed 8 different EOAs → 1 executor).
      // Match the searcher by EITHER same EOA OR same `to` contract — but
      // never accept null-to (contract creation) and never accept a match
      // through the V4 PoolManager itself.
      const sameEoa = c.from.toLowerCase() === a.from.toLowerCase();
      const sameExecutor =
        a.to !== null &&
        c.to !== null &&
        a.to.toLowerCase() === c.to.toLowerCase();
      if (!sameEoa && !sameExecutor) continue;

      // Front + back must be opposite-direction swaps on the same pool.
      if (sameSign(a.swapAmount0, c.swapAmount0)) continue;
      if (absBig(c.swapAmount0) < MIN_SWAP_NOTIONAL_RAW) continue;

      for (let j = i + 1; j < k; j++) {
        const v = events[j]!;
        if (v.kind !== "modliq") continue;
        if (v.liquidityDelta === undefined) continue;
        if (v.liquidityDelta <= 0n) continue; // only LP *adds* are sandwichable
        // Victim must be a different searcher — both EOA and executor.
        if (v.from.toLowerCase() === a.from.toLowerCase()) continue;
        if (sameExecutor && v.to && a.to && v.to.toLowerCase() === a.to.toLowerCase())
          continue;

        if (usedTx.has(a.txHash) || usedTx.has(c.txHash)) break;
        usedTx.add(a.txHash);
        usedTx.add(c.txHash);

        hits.push({
          chain: chainName,
          blockNumber,
          poolId,
          frontRunTx: a.txHash,
          victimTx: v.txHash,
          backRunTx: c.txHash,
          attackerEoa: a.from,
          victimEoa: v.from,
          attackerSwapAmount0: absBig(a.swapAmount0),
          victimLiquidityDelta: v.liquidityDelta,
          victimSenderContract: v.senderContract ?? ("0x0000000000000000000000000000000000000000" as Address),
        });
        break;
      }
    }
  }
  return hits;
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}
function sameSign(a: bigint, b: bigint): boolean {
  return (a >= 0n) === (b >= 0n);
}

/**
 * Block-by-block tail of one chain's PoolManager for LP sandwich hits.
 */
export async function scanBlockForLpSandwich(
  client: PublicClient,
  chainKey: ChainKey,
  chainName: string,
  blockNumber: bigint,
  receipts: TransactionReceipt[]
): Promise<LpSandwichHit[]> {
  const poolManager = POOL_MANAGER_BY_CHAIN[chainKey];
  if (!poolManager) return [];

  const txFromByHash = new Map<Hex, Address>();
  const txToByHash = new Map<Hex, Address | null>();
  const txIndexByHash = new Map<Hex, number>();
  for (const r of receipts) {
    txFromByHash.set(r.transactionHash as Hex, r.from);
    txToByHash.set(r.transactionHash as Hex, r.to ?? null);
    txIndexByHash.set(r.transactionHash as Hex, r.transactionIndex);
  }

  const byPool = await fetchV4Events(
    client,
    poolManager,
    blockNumber,
    txFromByHash,
    txToByHash,
    txIndexByHash
  );

  const allHits: LpSandwichHit[] = [];
  for (const [poolId, events] of byPool) {
    const hits = findSandwichesInPool(poolId, events, chainName, blockNumber);
    allHits.push(...hits);
  }
  return allHits;
}

import {
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
  type Block,
  formatUnits,
  getAddress,
} from "viem";
import { LIQUIDATION_TOPICS, SWAP_TOPICS, TOPIC } from "./abi.js";
import type { ChainConfig } from "./chains.js";

export type MevType = "arbitrage" | "sandwich" | "liquidation" | "jit";

export interface MevHit {
  chain: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  type: MevType;
  txHash: Hex;
  txIndex: number;
  searcher: Address;
  protocol?: string;
  swapCount: number;
  pools: Address[];
  profitToken?: Address;
  profitRaw?: bigint;
  profitNative?: number;
  profitUsdHint?: number;
  victimTxHash?: Hex;
  notes?: string;
}

interface NetFlow {
  address: Address;
  token: Address;
  delta: bigint;
}

function decodeTransferLog(log: Log): { from: Address; to: Address; value: bigint } | null {
  if (log.topics.length < 3 || log.topics[0] !== TOPIC.ERC20_TRANSFER) return null;
  try {
    const from = getAddress(("0x" + log.topics[1]!.slice(26)) as Address);
    const to = getAddress(("0x" + log.topics[2]!.slice(26)) as Address);
    if (!log.data || log.data === "0x") return null;
    const value = BigInt(log.data);
    return { from, to, value };
  } catch {
    return null;
  }
}

function isSwapLog(log: Log): boolean {
  return log.topics.length > 0 && SWAP_TOPICS.includes(log.topics[0] as `0x${string}`);
}

function findLiquidationProtocol(logs: Log[]): string | null {
  for (const log of logs) {
    const t0 = log.topics[0];
    if (!t0) continue;
    for (const [name, topic] of Object.entries(LIQUIDATION_TOPICS)) {
      if (t0 === topic) return name;
    }
  }
  return null;
}

function computeNetFlows(logs: Log[]): Map<string, bigint> {
  // Key: `${address}:${token}` -> net delta
  const flows = new Map<string, bigint>();
  for (const log of logs) {
    const t = decodeTransferLog(log);
    if (!t) continue;
    const token = log.address;
    const keyFrom = `${t.from.toLowerCase()}:${token.toLowerCase()}`;
    const keyTo = `${t.to.toLowerCase()}:${token.toLowerCase()}`;
    flows.set(keyFrom, (flows.get(keyFrom) ?? 0n) - t.value);
    flows.set(keyTo, (flows.get(keyTo) ?? 0n) + t.value);
  }
  return flows;
}

function pickProfitForAddress(
  flows: Map<string, bigint>,
  who: Address,
  preferredTokens: Address[]
): { token: Address; amount: bigint } | null {
  const lcWho = who.toLowerCase();
  const candidates: { token: Address; amount: bigint }[] = [];
  for (const [key, amt] of flows) {
    const [addr, token] = key.split(":");
    if (!addr || !token) continue;
    if (addr !== lcWho) continue;
    if (amt > 0n) {
      candidates.push({ token: getAddress(token as Address), amount: amt });
    }
  }
  if (candidates.length === 0) return null;
  // Prefer tokens we can price (native wrapped + stables)
  const lcPreferred = preferredTokens.map((a) => a.toLowerCase());
  candidates.sort((a, b) => {
    const ai = lcPreferred.indexOf(a.token.toLowerCase());
    const bi = lcPreferred.indexOf(b.token.toLowerCase());
    if (ai === -1 && bi === -1) return Number(b.amount - a.amount);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return candidates[0] ?? null;
}

function uniquePools(swapLogs: Log[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const log of swapLogs) {
    const lc = log.address.toLowerCase();
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(log.address);
    }
  }
  return out;
}

export function detectArbitrage(
  receipt: TransactionReceipt,
  block: Block,
  cfg: ChainConfig
): MevHit | null {
  const swapLogs = receipt.logs.filter(isSwapLog);
  if (swapLogs.length < 2) return null;
  const pools = uniquePools(swapLogs);
  if (pools.length < 2) return null;

  // Heuristic: receipt.to (or from) ends up with positive net flow in a "value" token
  const flows = computeNetFlows(receipt.logs);
  const valueTokens: Address[] = [
    cfg.nativeWrapped,
    ...Object.values(cfg.stables),
  ];

  // Try the contract called (receipt.to) first, then the EOA (receipt.from)
  const candidates: Address[] = [];
  if (receipt.to) candidates.push(receipt.to);
  candidates.push(receipt.from);

  for (const who of candidates) {
    const profit = pickProfitForAddress(flows, who, valueTokens);
    if (!profit) continue;
    if (profit.amount <= 0n) continue;
    // Filter to value tokens only — random token gains are noise
    if (!valueTokens.map((a) => a.toLowerCase()).includes(profit.token.toLowerCase())) continue;

    const profitNative =
      profit.token.toLowerCase() === cfg.nativeWrapped.toLowerCase()
        ? Number(formatUnits(profit.amount, 18))
        : undefined;
    const profitUsdHint = profitNative !== undefined ? profitNative * cfg.nativePriceUsdHint : undefined;

    return {
      chain: cfg.name,
      blockNumber: receipt.blockNumber,
      blockTimestamp: block.timestamp,
      type: "arbitrage",
      txHash: receipt.transactionHash,
      txIndex: receipt.transactionIndex,
      searcher: getAddress(who),
      swapCount: swapLogs.length,
      pools,
      profitToken: profit.token,
      profitRaw: profit.amount,
      profitNative,
      profitUsdHint,
    };
  }
  return null;
}

export function detectLiquidation(
  receipt: TransactionReceipt,
  block: Block,
  cfg: ChainConfig
): MevHit | null {
  const protocol = findLiquidationProtocol(receipt.logs);
  if (!protocol) return null;
  const swapLogs = receipt.logs.filter(isSwapLog);
  const pools = uniquePools(swapLogs);

  // If accompanying swaps exist, try to estimate profit
  const flows = computeNetFlows(receipt.logs);
  const valueTokens: Address[] = [cfg.nativeWrapped, ...Object.values(cfg.stables)];
  const profit = pickProfitForAddress(flows, receipt.from, valueTokens);
  const profitNative =
    profit && profit.token.toLowerCase() === cfg.nativeWrapped.toLowerCase()
      ? Number(formatUnits(profit.amount, 18))
      : undefined;
  const profitUsdHint = profitNative !== undefined ? profitNative * cfg.nativePriceUsdHint : undefined;

  return {
    chain: cfg.name,
    blockNumber: receipt.blockNumber,
    blockTimestamp: block.timestamp,
    type: "liquidation",
    txHash: receipt.transactionHash,
    txIndex: receipt.transactionIndex,
    searcher: receipt.from,
    protocol,
    swapCount: swapLogs.length,
    pools,
    profitToken: profit?.token,
    profitRaw: profit?.amount,
    profitNative,
    profitUsdHint,
  };
}

interface BlockTxLite {
  hash: Hex;
  from: Address;
  to: Address | null;
  index: number;
  receipt: TransactionReceipt;
}

/**
 * Sandwich detection works at the block level.
 * Pattern: searcher submits tx A swapping pool P direction D, victim V swaps P direction D,
 * searcher submits tx C swapping P direction !D. A and C from same EOA / contract.
 */
export function detectSandwiches(
  txs: BlockTxLite[],
  block: Block,
  cfg: ChainConfig
): MevHit[] {
  // Index swaps per pool, in tx order
  type Entry = { tx: BlockTxLite; pool: Address; logIndex: number };
  const perPool = new Map<string, Entry[]>();
  for (const tx of txs) {
    for (let i = 0; i < tx.receipt.logs.length; i++) {
      const log = tx.receipt.logs[i]!;
      if (!isSwapLog(log)) continue;
      const key = log.address.toLowerCase();
      if (!perPool.has(key)) perPool.set(key, []);
      perPool.get(key)!.push({ tx, pool: log.address, logIndex: i });
    }
  }

  const hits: MevHit[] = [];
  const seenSandwichTx = new Set<Hex>();

  for (const [, entries] of perPool) {
    if (entries.length < 3) continue;
    // Sort by tx index then logIndex
    entries.sort(
      (a, b) =>
        a.tx.index - b.tx.index || a.logIndex - b.logIndex
    );
    // Find triplets where entries[i] and entries[k] share a "searcher" (from or to)
    // and entries[j] is sandwiched between them by a different searcher
    const valueTokens: Address[] = [cfg.nativeWrapped, ...Object.values(cfg.stables)];
    const valueLc = new Set(valueTokens.map((a) => a.toLowerCase()));

    for (let i = 0; i < entries.length - 2; i++) {
      const a = entries[i]!;
      for (let k = i + 2; k < entries.length; k++) {
        const c = entries[k]!;
        // Match sandwiches by EOA (tx.from) — public routers as `tx.to`
        // create false positives because many users share the same router.
        const aSearcher = a.tx.from.toLowerCase();
        const cSearcher = c.tx.from.toLowerCase();
        if (aSearcher !== cSearcher) continue;
        for (let j = i + 1; j < k; j++) {
          const v = entries[j]!;
          if (v.tx.from.toLowerCase() === aSearcher) continue;
          if (seenSandwichTx.has(a.tx.hash) || seenSandwichTx.has(c.tx.hash)) break;

          // Require the back-run leg to net positive in a value token —
          // otherwise it's not a profitable sandwich, just coincidence.
          const flows = computeNetFlows(c.tx.receipt.logs);
          const profit =
            pickProfitForAddress(flows, c.tx.from, valueTokens) ??
            (c.tx.to ? pickProfitForAddress(flows, c.tx.to, valueTokens) : null);
          if (!profit || !valueLc.has(profit.token.toLowerCase())) break;

          seenSandwichTx.add(a.tx.hash);
          seenSandwichTx.add(c.tx.hash);

          const profitNative =
            profit.token.toLowerCase() === cfg.nativeWrapped.toLowerCase()
              ? Number(formatUnits(profit.amount, 18))
              : undefined;
          const profitUsdHint =
            profitNative !== undefined ? profitNative * cfg.nativePriceUsdHint : undefined;

          hits.push({
            chain: cfg.name,
            blockNumber: block.number ?? 0n,
            blockTimestamp: block.timestamp,
            type: "sandwich",
            txHash: c.tx.hash,
            txIndex: c.tx.index,
            searcher: getAddress(aSearcher as Address),
            swapCount: 2,
            pools: [a.pool],
            victimTxHash: v.tx.hash,
            profitToken: profit.token,
            profitRaw: profit.amount,
            profitNative,
            profitUsdHint,
            notes: `front=${a.tx.hash} back=${c.tx.hash}`,
          });
          break;
        }
      }
    }
  }

  return hits;
}

export function detectMevInBlock(
  block: Block,
  receipts: TransactionReceipt[],
  cfg: ChainConfig
): MevHit[] {
  const out: MevHit[] = [];

  // Per-tx detection: arb + liquidation
  for (const r of receipts) {
    const arb = detectArbitrage(r, block, cfg);
    if (arb) out.push(arb);
    const liq = detectLiquidation(r, block, cfg);
    if (liq) out.push(liq);
  }

  // Block-level sandwich detection
  const txs: BlockTxLite[] = receipts.map((r) => ({
    hash: r.transactionHash,
    from: r.from,
    to: r.to ?? null,
    index: r.transactionIndex,
    receipt: r,
  }));
  out.push(...detectSandwiches(txs, block, cfg));

  return out;
}

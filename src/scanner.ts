import {
  createPublicClient,
  http,
  webSocket,
  type Block,
  type PublicClient,
  type TransactionReceipt,
  formatUnits,
} from "viem";
import { detectMevInBlock, type MevHit } from "./detect.js";
import { CHAINS, type ChainConfig } from "./chains.js";

// Lookup table: chain display name -> ChainConfig. Avoids passing cfg through
// every layer just for log formatting.
const chainCfgByName = new Map<string, ChainConfig>(
  Object.values(CHAINS).map((c) => [c.name, c])
);

interface ScannerOptions {
  cfg: ChainConfig;
  onHit?: (hit: MevHit) => void;
  fromBlock?: bigint;
  pollIntervalMs?: number;
  blockBatch?: number;
  verbose?: boolean;
}

function makeClient(cfg: ChainConfig): PublicClient {
  const transport = cfg.wsUrl ? webSocket(cfg.wsUrl) : http(cfg.rpcUrl);
  return createPublicClient({ transport }) as PublicClient;
}

// Stable decimals — most stables on EVM chains are 6 decimals (USDC, USDT, USDbC).
// DAI is 18. Honey on Berachain is 18.
const STABLE_DECIMALS_BY_SYMBOL: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  USDbC: 6,
  DAI: 18,
  HONEY: 18,
};

function stableSymbolFor(addr: string, cfg: ChainConfig): string | null {
  const lc = addr.toLowerCase();
  for (const [sym, a] of Object.entries(cfg.stables)) {
    if (a.toLowerCase() === lc) return sym;
  }
  return null;
}

function fmtProfit(hit: MevHit, cfg: ChainConfig): string {
  if (hit.profitUsdHint !== undefined) {
    return `~$${hit.profitUsdHint.toFixed(2)}`;
  }
  if (hit.profitNative !== undefined) {
    return `${hit.profitNative.toFixed(6)} ${cfg.nativeSymbol}`;
  }
  if (hit.profitRaw !== undefined && hit.profitToken) {
    const sym = stableSymbolFor(hit.profitToken, cfg);
    if (sym) {
      const decimals = STABLE_DECIMALS_BY_SYMBOL[sym] ?? 18;
      const usd = Number(formatUnits(hit.profitRaw, decimals));
      return `~$${usd.toFixed(2)}`;
    }
    return "unknown-token";
  }
  return "n/a";
}

function logHit(hit: MevHit): void {
  const ts = new Date(Number(hit.blockTimestamp) * 1000).toISOString();
  const tag =
    hit.type === "arbitrage" ? "ARB " :
    hit.type === "sandwich" ? "SAND" :
    hit.type === "liquidation" ? "LIQ " : "JIT ";
  const proto = hit.protocol ? ` [${hit.protocol}]` : "";
  const cfg = chainCfgByName.get(hit.chain);
  const profit = cfg ? fmtProfit(hit, cfg) : "n/a";
  const victim = hit.victimTxHash ? ` victim=${hit.victimTxHash.slice(0, 10)}…` : "";
  console.log(
    `[${hit.chain}] ${ts} blk=${hit.blockNumber} ${tag}${proto} ` +
      `tx=${hit.txHash.slice(0, 10)}… searcher=${hit.searcher.slice(0, 10)}… ` +
      `swaps=${hit.swapCount} pools=${hit.pools.length} profit=${profit}${victim}`
  );
}

// Cache per-client whether eth_getBlockReceipts is supported.
// Avoids slamming the RPC with per-tx receipts when batch isn't available.
const blockReceiptsSupport = new WeakMap<PublicClient, boolean>();

export async function fetchBlockWithReceipts(
  client: PublicClient,
  blockNumber: bigint
): Promise<{ block: Block; receipts: TransactionReceipt[] }> {
  const block = await client.getBlock({ blockNumber, includeTransactions: false });
  if (!block.transactions || block.transactions.length === 0) {
    return { block, receipts: [] };
  }

  const supported = blockReceiptsSupport.get(client);

  if (supported !== false) {
    try {
      const raw = (await client.request({
        method: "eth_getBlockReceipts" as any,
        params: [`0x${blockNumber.toString(16)}`] as any,
      })) as unknown as any[];
      blockReceiptsSupport.set(client, true);
      const receipts = raw.map((r: any) => ({
        ...r,
        blockNumber: BigInt(r.blockNumber),
        transactionIndex: Number(r.transactionIndex),
        gasUsed: r.gasUsed ? BigInt(r.gasUsed) : 0n,
        cumulativeGasUsed: r.cumulativeGasUsed ? BigInt(r.cumulativeGasUsed) : 0n,
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : 0n,
        logs: (r.logs ?? []).map((l: any) => ({
          ...l,
          blockNumber: BigInt(l.blockNumber ?? 0),
          logIndex: Number(l.logIndex ?? 0),
          transactionIndex: Number(l.transactionIndex ?? 0),
        })),
      })) as TransactionReceipt[];
      return { block, receipts };
    } catch (err) {
      // First failure → mark unsupported so we don't keep retrying.
      if (supported === undefined) {
        blockReceiptsSupport.set(client, false);
        console.error(
          `[scanner] eth_getBlockReceipts unsupported on this RPC, falling back to per-tx (slower)`
        );
      } else {
        throw err;
      }
    }
  }

  // Fallback: per-tx receipts. Throttle by sequencing serially to avoid rate limits.
  const hashes = block.transactions as `0x${string}`[];
  const receipts: TransactionReceipt[] = [];
  for (const h of hashes) {
    receipts.push(await client.getTransactionReceipt({ hash: h }));
  }
  return { block, receipts };
}

export async function scanBlock(
  client: PublicClient,
  cfg: ChainConfig,
  blockNumber: bigint,
  opts: { onHit?: (h: MevHit) => void; verbose?: boolean } = {}
): Promise<MevHit[]> {
  const { block, receipts } = await fetchBlockWithReceipts(client, blockNumber);
  const hits = detectMevInBlock(block, receipts, cfg);
  if (opts.verbose) {
    console.log(
      `[${cfg.name}] block ${blockNumber} txs=${receipts.length} hits=${hits.length}`
    );
  }
  for (const h of hits) {
    if (opts.onHit) opts.onHit(h);
    logHit(h);
  }
  return hits;
}

export async function scanLive(opts: ScannerOptions): Promise<void> {
  const { cfg } = opts;
  const client = makeClient(cfg);
  const pollMs = opts.pollIntervalMs ?? Math.max(500, cfg.blockTimeSec * 1000 - 200);
  const verbose = opts.verbose ?? false;

  let head = opts.fromBlock ?? (await client.getBlockNumber());
  console.log(`[${cfg.name}] starting live scan from block ${head}, poll=${pollMs}ms`);

  // Continuous polling loop
  for (;;) {
    try {
      const tip = await client.getBlockNumber();
      while (head <= tip) {
        await scanBlock(client, cfg, head, {
          onHit: opts.onHit,
          verbose,
        });
        head++;
      }
    } catch (err) {
      console.error(`[${cfg.name}] scan error:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function scanRange(
  cfg: ChainConfig,
  fromBlock: bigint,
  toBlock: bigint,
  opts: { onHit?: (h: MevHit) => void; verbose?: boolean } = {}
): Promise<MevHit[]> {
  const client = makeClient(cfg);
  const all: MevHit[] = [];
  for (let n = fromBlock; n <= toBlock; n++) {
    try {
      const hits = await scanBlock(client, cfg, n, opts);
      all.push(...hits);
    } catch (err) {
      console.error(`[${cfg.name}] block ${n} failed:`, (err as Error).message);
    }
  }
  return all;
}

/**
 * Block-range scanner that finds triangular (and N-cycle) arbs.
 *
 * For each block, this fetches the block + receipts (using the same fast-path
 * `eth_getBlockReceipts` plumbing as src/scanner.ts), then runs the per-tx
 * decoder on every tx. Hits are surfaced via callback for streaming use.
 *
 * Performance: the heaviest cost is V4 Initialize lookups (one per fresh
 * pool, then cached). For a fully cold cache on Base, expect ~3s/block on
 * the first ~10 blocks; after that the cache amortizes to ~200ms/block.
 */

import {
  createPublicClient,
  http,
  webSocket,
  type Address,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from "viem";
import { CHAINS, type ChainConfig, type ChainKey } from "../src/chains.js";
import { POOL_MANAGER_BY_CHAIN } from "../uniswap/v4-lp-sandwich.js";
import { fetchBlockWithReceipts } from "../src/scanner.js";
import { decodeArbFromReceipt, type DecodedArb } from "./decode.js";

export interface ScanOptions {
  cfg: ChainConfig;
  fromBlock: bigint;
  toBlock: bigint;
  onHit?: (hit: DecodedArb) => void;
  verbose?: boolean;
}

export interface LiveScanOptions {
  cfg: ChainConfig;
  fromBlock?: bigint;
  onHit?: (hit: DecodedArb) => void;
  verbose?: boolean;
  pollIntervalMs?: number;
}

function makeClient(cfg: ChainConfig): PublicClient {
  const transport = cfg.wsUrl ? webSocket(cfg.wsUrl) : http(cfg.rpcUrl);
  return createPublicClient({ transport }) as PublicClient;
}

/**
 * Scan a closed [from, to] block range. Returns all hits and also pipes
 * each to onHit as they're discovered.
 */
export async function scanRange(opts: ScanOptions): Promise<DecodedArb[]> {
  const { cfg, fromBlock, toBlock, onHit, verbose } = opts;
  const client = makeClient(cfg);
  const poolManager = POOL_MANAGER_BY_CHAIN[cfg.key];
  const all: DecodedArb[] = [];

  for (let n = fromBlock; n <= toBlock; n++) {
    try {
      const { block, receipts } = await fetchBlockWithReceipts(client, n);
      // Map tx hash → tx (for from/to access).
      const txByHash = new Map<string, Transaction>();
      // viem's getBlock with includeTransactions=false returns just hashes
      // but we still have receipts with .from / .to populated, which is
      // sufficient for our purposes (we don't need value / nonce here).
      const _ = block;
      let hitsThisBlock = 0;

      for (const receipt of receipts) {
        // Quick filter — needs ≥2 logs to even consider.
        if (receipt.logs.length < 2) continue;
        const fakeTx = {
          hash: receipt.transactionHash,
          from: receipt.from,
          to: receipt.to,
        } as unknown as Transaction;
        const arb = await decodeArbFromReceipt(client, fakeTx, receipt, {
          chain: cfg.name,
          poolManager,
          searchUpToBlock: n,
        });
        if (arb) {
          all.push(arb);
          hitsThisBlock++;
          if (onHit) onHit(arb);
        }
      }

      if (verbose) {
        console.log(
          `[${cfg.name}] block ${n} txs=${receipts.length} arb_hits=${hitsThisBlock}`
        );
      }
    } catch (err) {
      console.error(`[${cfg.name}] block ${n} failed: ${(err as Error).message}`);
    }
  }
  return all;
}

/**
 * Live tail. Polls for new blocks and scans each as it arrives.
 */
export async function scanLive(opts: LiveScanOptions): Promise<void> {
  const { cfg } = opts;
  const client = makeClient(cfg);
  const pollMs = opts.pollIntervalMs ?? Math.max(500, cfg.blockTimeSec * 1000 - 200);
  const poolManager = POOL_MANAGER_BY_CHAIN[cfg.key];

  let head = opts.fromBlock ?? (await client.getBlockNumber());
  console.log(`[${cfg.name}] arb-decoder live, from block ${head}, poll=${pollMs}ms`);

  for (;;) {
    try {
      const tip = await client.getBlockNumber();
      while (head <= tip) {
        const { receipts } = await fetchBlockWithReceipts(client, head);
        let hits = 0;
        for (const r of receipts) {
          if (r.logs.length < 2) continue;
          const fakeTx = {
            hash: r.transactionHash, from: r.from, to: r.to,
          } as unknown as Transaction;
          const arb = await decodeArbFromReceipt(client, fakeTx, r, {
            chain: cfg.name, poolManager, searchUpToBlock: head,
          });
          if (arb) {
            hits++;
            if (opts.onHit) opts.onHit(arb);
          }
        }
        if (opts.verbose) {
          console.log(`[${cfg.name}] block ${head} arb_hits=${hits}`);
        }
        head++;
      }
    } catch (err) {
      console.error(`[${cfg.name}] live scan: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Decode a specific transaction hash. Convenience wrapper around the core
 * decoder for the CLI "decode" mode.
 */
export async function decodeOneTx(
  chainKey: ChainKey,
  txHash: `0x${string}`
): Promise<DecodedArb | null> {
  const cfg = CHAINS[chainKey];
  const client = makeClient(cfg);
  const poolManager = POOL_MANAGER_BY_CHAIN[chainKey];
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const tx = await client.getTransaction({ hash: txHash });
  return decodeArbFromReceipt(client, tx, receipt, {
    chain: cfg.name,
    poolManager,
    searchUpToBlock: receipt.blockNumber,
  });
}

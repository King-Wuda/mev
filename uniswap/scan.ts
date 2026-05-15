import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { CHAINS, type ChainKey } from "../src/chains.js";
import { fetchBlockWithReceipts } from "../src/scanner.js";
import {
  POOL_MANAGER_BY_CHAIN,
  scanBlockForLpSandwich,
  type LpSandwichHit,
} from "./v4-lp-sandwich.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

function makeClient(chainKey: ChainKey): PublicClient {
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

interface Args {
  chain: ChainKey;
  mode: "live" | "range" | "block";
  block?: bigint;
  from?: bigint;
  to?: bigint;
  pollMs: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const chain = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "base") as ChainKey;
  const flags = argv.slice(1);
  const get = (k: string) =>
    flags.find((x) => x.startsWith(`--${k}=`))?.split("=", 2)[1];
  return {
    chain,
    mode: (get("mode") as "live" | "range" | "block") ?? "live",
    block: get("block") ? BigInt(get("block")!) : undefined,
    from: get("from") ? BigInt(get("from")!) : undefined,
    to: get("to") ? BigInt(get("to")!) : undefined,
    pollMs: Number(get("poll") ?? "2000"),
    verbose: flags.includes("--verbose"),
  };
}

function fmtHit(h: LpSandwichHit): string {
  const ts = new Date().toISOString();
  return (
    `[${h.chain}] ${ts} blk=${h.blockNumber} V4-LP-SANDWICH\n` +
    `   pool=${h.poolId.slice(0, 12)}…\n` +
    `   attacker=${h.attackerEoa} (front=${h.frontRunTx.slice(0, 10)}… back=${h.backRunTx.slice(0, 10)}…)\n` +
    `   victim  =${h.victimEoa} (LP-add tx=${h.victimTx.slice(0, 10)}…)\n` +
    `   victim periphery=${h.victimSenderContract.slice(0, 10)}…\n` +
    `   victim liquidityDelta=${h.victimLiquidityDelta.toString()}\n` +
    `   attacker swap amount0=${h.attackerSwapAmount0.toString()}\n`
  );
}

async function processBlock(
  client: PublicClient,
  chainKey: ChainKey,
  chainName: string,
  blockNumber: bigint,
  verbose: boolean
): Promise<LpSandwichHit[]> {
  const { receipts } = await fetchBlockWithReceipts(client, blockNumber);
  const hits = await scanBlockForLpSandwich(
    client,
    chainKey,
    chainName,
    blockNumber,
    receipts
  );
  if (verbose) {
    console.log(
      `[${chainName}] block ${blockNumber} txs=${receipts.length} v4_lp_sandwiches=${hits.length}`
    );
  }
  for (const h of hits) console.log(fmtHit(h));
  return hits;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = CHAINS[args.chain];
  if (!POOL_MANAGER_BY_CHAIN[args.chain]) {
    console.error(
      `No Uniswap V4 PoolManager configured for ${args.chain}. ` +
        `Supported: ${Object.keys(POOL_MANAGER_BY_CHAIN).join(", ")}`
    );
    process.exit(2);
  }
  const client = makeClient(args.chain);

  if (args.mode === "block") {
    if (!args.block) {
      console.error("--block=N required for mode=block");
      process.exit(2);
    }
    await processBlock(client, args.chain, cfg.name, args.block, true);
    return;
  }
  if (args.mode === "range") {
    if (args.from === undefined || args.to === undefined) {
      console.error("--from=N --to=N required for mode=range");
      process.exit(2);
    }
    let total = 0;
    for (let n = args.from; n <= args.to; n++) {
      try {
        const hits = await processBlock(client, args.chain, cfg.name, n, args.verbose);
        total += hits.length;
      } catch (e) {
        console.error(`block ${n} failed: ${(e as Error).message}`);
      }
    }
    console.log(`\nrange scan complete. total V4 LP sandwiches: ${total}`);
    return;
  }

  // live tail
  let head = args.from ?? (await client.getBlockNumber());
  console.log(
    `[${cfg.name}] V4 LP sandwich tail starting at block ${head} (poll=${args.pollMs}ms)`
  );
  for (;;) {
    try {
      const tip = await client.getBlockNumber();
      while (head <= tip) {
        await processBlock(client, args.chain, cfg.name, head, args.verbose);
        head++;
      }
    } catch (e) {
      console.error(`scan error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

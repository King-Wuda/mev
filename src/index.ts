import { ALL_CHAINS, CHAINS, type ChainKey } from "./chains.js";
import { scanLive, scanRange, scanBlock } from "./scanner.js";
import { createPublicClient, http } from "viem";
import type { MevHit } from "./detect.js";

function printHelp(): void {
  console.log(`MEV Scanner — read-only multi-chain MEV detector

Usage:
  npm run scan <chain> [--mode=live|range|block] [--from=N] [--to=N] [--block=N] [--verbose]

Chains:
  ${ALL_CHAINS.join(", ")}, all

Modes:
  live   (default) — tail the chain head, scanning each new block
  range  — scan a closed block range [--from N --to N]
  block  — scan a single block (--block N)

Examples:
  npm run scan base
  npm run scan base -- --mode=range --from=23456000 --to=23456020
  npm run scan all -- --verbose
  npm run scan monad -- --mode=block --block=1234567

Env vars (override default RPCs):
  BASE_RPC, MONAD_RPC, BERA_RPC, ABSTRACT_RPC, HYPEREVM_RPC
  BASE_WS,  MONAD_WS,  BERA_WS,  ABSTRACT_WS,  HYPEREVM_WS
`);
}

function parseArgs(argv: string[]): {
  chain: string;
  mode: "live" | "range" | "block";
  from?: bigint;
  to?: bigint;
  block?: bigint;
  verbose: boolean;
} {
  const chain = argv[0];
  if (!chain) {
    printHelp();
    process.exit(0);
  }
  const flags = argv.slice(1);
  const get = (k: string): string | undefined => {
    const f = flags.find((x) => x.startsWith(`--${k}=`));
    return f ? f.split("=", 2)[1] : undefined;
  };
  return {
    chain,
    mode: (get("mode") as "live" | "range" | "block") ?? "live",
    from: get("from") ? BigInt(get("from")!) : undefined,
    to: get("to") ? BigInt(get("to")!) : undefined,
    block: get("block") ? BigInt(get("block")!) : undefined,
    verbose: flags.includes("--verbose"),
  };
}

async function runForChain(
  key: ChainKey,
  args: ReturnType<typeof parseArgs>,
  onHit: (h: MevHit) => void
): Promise<void> {
  const cfg = CHAINS[key];

  if (args.mode === "block") {
    if (args.block === undefined) {
      console.error("--block=N required for mode=block");
      process.exit(2);
    }
    const client = createPublicClient({ transport: http(cfg.rpcUrl) });
    await scanBlock(client as any, cfg, args.block, { onHit, verbose: args.verbose });
    return;
  }

  if (args.mode === "range") {
    if (args.from === undefined || args.to === undefined) {
      console.error("--from=N and --to=N required for mode=range");
      process.exit(2);
    }
    await scanRange(cfg, args.from, args.to, { onHit, verbose: args.verbose });
    return;
  }

  // live
  await scanLive({
    cfg,
    onHit,
    fromBlock: args.from,
    verbose: args.verbose,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let totalHits = 0;
  const onHit = (_h: MevHit) => {
    totalHits++;
  };

  // Print stats every 30s in live mode
  if (args.mode === "live") {
    setInterval(() => {
      console.log(`[stats] total MEV hits detected: ${totalHits}`);
    }, 30_000);
  }

  if (args.chain === "all") {
    await Promise.all(
      ALL_CHAINS.map((k) => runForChain(k, args, onHit).catch((e) => {
        console.error(`[${k}] fatal:`, (e as Error).message);
      }))
    );
    return;
  }

  if (!(args.chain in CHAINS)) {
    console.error(`unknown chain: ${args.chain}`);
    printHelp();
    process.exit(2);
  }
  await runForChain(args.chain as ChainKey, args, onHit);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

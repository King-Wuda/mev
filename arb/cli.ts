/**
 * CLI for the arb decoder/scanner/aggregator.
 *
 * Modes:
 *   decode    <txhash>         Decode a single tx (foundation mode).
 *   scan      <chain> [opts]   Block-range or live scan.
 *   aggregate <chain> [opts]   Scan a range, then print pattern summary.
 *
 * Examples:
 *   npx tsx arb/cli.ts decode 0xabc... --chain=base
 *   npx tsx arb/cli.ts scan base --from=46000000 --to=46000100 --verbose
 *   npx tsx arb/cli.ts scan base --live
 *   npx tsx arb/cli.ts aggregate base --from=46000000 --to=46000500
 */

import { CHAINS, type ChainKey } from "../src/chains.js";
import { TOKENS } from "../src/dexes.js";
import { decodeOneTx, scanLive, scanRange } from "./scan.js";
import { aggregate, printSummary } from "./aggregate.js";
import type { DecodedArb } from "./decode.js";
import { formatUnits } from "viem";

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (process.argv.includes(`--${name}`)) return "true";
  return fallback;
}

function symbolMapFor(chain: ChainKey): Map<string, string> {
  const m = new Map<string, string>();
  const tokens = TOKENS[chain] ?? [];
  for (const t of tokens) m.set(t.address.toLowerCase(), t.symbol);
  return m;
}

function decimalsMapFor(chain: ChainKey): Map<string, number> {
  const m = new Map<string, number>();
  const tokens = TOKENS[chain] ?? [];
  for (const t of tokens) m.set(t.address.toLowerCase(), t.decimals);
  return m;
}

function fmtAmount(addr: string, raw: bigint, decimalsBy: Map<string, number>): string {
  const d = decimalsBy.get(addr.toLowerCase()) ?? 18;
  return formatUnits(raw, d);
}

function logArb(arb: DecodedArb, symbols: Map<string, string>, decimalsBy: Map<string, number>): void {
  const sym = (a: string) => symbols.get(a.toLowerCase()) ?? a.slice(0, 8);
  const path = [arb.hops[0]!.tokenIn, ...arb.hops.map((h) => h.tokenOut)]
    .map(sym)
    .join("→");
  const profit = fmtAmount(arb.anchor, arb.grossProfitRaw, decimalsBy);
  const gasEth = formatUnits(arb.gasCostWei, 18);
  const dex = arb.dexMix.join("+");
  console.log(
    `[${arb.chain}] blk=${arb.blockNumber} ${arb.txHash.slice(0, 10)}… ` +
      `searcher=${arb.searcher.slice(0, 10)}… executor=${(arb.executor ?? "-").slice(0, 10)}… ` +
      `${arb.hops.length}-hop ${dex}  ${path}  gross=+${profit} ${sym(arb.anchor)}  ` +
      `gas=${gasEth} ETH`
  );
}

async function cmdDecode(): Promise<void> {
  const txHash = process.argv[3];
  if (!txHash || !txHash.startsWith("0x")) {
    console.error("Usage: cli.ts decode <txhash> --chain=base");
    process.exit(1);
  }
  const chainKey = (arg("chain") as ChainKey) ?? "base";
  if (!(chainKey in CHAINS)) {
    console.error(`Unknown chain: ${chainKey}`);
    process.exit(1);
  }
  const arb = await decodeOneTx(chainKey, txHash as `0x${string}`);
  if (!arb) {
    console.log(`No closed-cycle arb decoded from ${txHash}`);
    return;
  }
  const symbols = symbolMapFor(chainKey);
  const decimalsBy = decimalsMapFor(chainKey);
  logArb(arb, symbols, decimalsBy);
  console.log("\nHop breakdown:");
  for (let i = 0; i < arb.hops.length; i++) {
    const h = arb.hops[i]!;
    const sIn = symbols.get(h.tokenIn) ?? h.tokenIn.slice(0, 8);
    const sOut = symbols.get(h.tokenOut) ?? h.tokenOut.slice(0, 8);
    const aIn = fmtAmount(h.tokenIn, h.amountIn, decimalsBy);
    const aOut = fmtAmount(h.tokenOut, h.amountOut, decimalsBy);
    console.log(
      `  ${i + 1}. [${h.family}] ${h.poolId.slice(0, 14)}…  ` +
        `${aIn} ${sIn} → ${aOut} ${sOut}`
    );
  }
}

function chainKeyArg(): ChainKey {
  const k = process.argv[3] as ChainKey | undefined;
  if (!k || !(k in CHAINS)) {
    console.error("Usage: cli.ts scan|aggregate <chain> [opts]");
    process.exit(1);
  }
  return k;
}

async function cmdScan(): Promise<void> {
  const chainKey = chainKeyArg();
  const cfg = CHAINS[chainKey];
  const verbose = arg("verbose") === "true";
  const symbols = symbolMapFor(chainKey);
  const decimalsBy = decimalsMapFor(chainKey);

  if (arg("live") === "true") {
    await scanLive({
      cfg,
      verbose,
      onHit: (a) => logArb(a, symbols, decimalsBy),
    });
    return;
  }

  const fromStr = arg("from");
  const toStr = arg("to");
  if (!fromStr || !toStr) {
    console.error("scan requires --from=N --to=M (or --live)");
    process.exit(1);
  }
  const from = BigInt(fromStr);
  const to = BigInt(toStr);
  const hits = await scanRange({
    cfg,
    fromBlock: from,
    toBlock: to,
    verbose,
    onHit: (a) => logArb(a, symbols, decimalsBy),
  });
  console.log(`\nDone. ${hits.length} arbs found across ${to - from + 1n} blocks.`);
}

async function cmdAggregate(): Promise<void> {
  const chainKey = chainKeyArg();
  const cfg = CHAINS[chainKey];
  const fromStr = arg("from");
  const toStr = arg("to");
  if (!fromStr || !toStr) {
    console.error("aggregate requires --from=N --to=M");
    process.exit(1);
  }
  const from = BigInt(fromStr);
  const to = BigInt(toStr);
  const verbose = arg("verbose") === "true";
  const symbols = symbolMapFor(chainKey);
  const decimalsBy = decimalsMapFor(chainKey);
  const hits = await scanRange({
    cfg,
    fromBlock: from,
    toBlock: to,
    verbose,
    onHit: (a) => {
      if (verbose) logArb(a, symbols, decimalsBy);
    },
  });
  const summary = aggregate(hits, { knownSymbols: symbols });
  printSummary(summary, (a) => symbols.get(a.toLowerCase()) ?? a.slice(0, 8));
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  switch (mode) {
    case "decode": return cmdDecode();
    case "scan": return cmdScan();
    case "aggregate": return cmdAggregate();
    default:
      console.error("Usage: cli.ts <decode|scan|aggregate> ...");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

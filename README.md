# MEV Scanner

Read-only multi-chain MEV transaction detector. Tails the chain head, classifies on-chain activity into arbitrage / sandwich / liquidation, and prints a one-line summary per hit with a USD profit estimate when possible.

No private keys, no on-chain spending. Pure observability.

## Supported chains

- **Base** (default RPC: `https://base-rpc.publicnode.com`)
- **Monad** (`https://rpc.monad.xyz`)
- **Berachain** (`https://rpc.berachain.com`)
- **Abstract** (`https://api.mainnet.abs.xyz`)
- **Hyperliquid HyperEVM** (`https://rpc.hyperliquid.xyz/evm`)

Override any of these via env vars: `BASE_RPC`, `MONAD_RPC`, `BERA_RPC`, `ABSTRACT_RPC`, `HYPEREVM_RPC` (plus `_WS` variants for WebSocket).

## Setup

```bash
npm install
```

## Usage

```bash
# Live tail (default)
npm run scan base
npm run scan monad
npm run scan all          # all chains in parallel

# Specific block range
npm run scan base -- --mode=range --from=45683500 --to=45683520

# Single block
npm run scan base -- --mode=block --block=45683524

# Verbose mode shows every block scanned
npm run scan base -- --verbose
```

Output format:

```
[Base] 2026-05-07T12:19:55Z blk=45683524 ARB  tx=0xceaa1a84… searcher=0xb24c0214… swaps=3 pools=3 profit=~$35000.48
[Base] 2026-05-07T12:19:43Z blk=45683518 SAND tx=0xbfd17e8c… searcher=0xF04a2505… swaps=2 pools=1 profit=~$809.62 victim=0x13d0ccfd…
```

## Detection heuristics

**Arbitrage** — a tx with ≥2 swap events across ≥2 pools whose `to` contract or `from` EOA ends with a positive net flow in a value token (native wrapped, USDC, etc).

**Sandwich** — three swaps on the same pool within one block, where the first and third are submitted by the same EOA and the third nets positive in a value token. The middle tx is the victim.

**Liquidation** — emission of a known liquidation event signature: Aave V3 `LiquidationCall`, Compound V3 `AbsorbCollateral`, Compound V2 `LiquidateBorrow`, Morpho Blue `Liquidate`.

**JIT** — not yet implemented (would require Mint+Swap+Burn pattern detection within one block).

## Limitations

- **Profit estimates are USD hints only.** Native price uses a hardcoded sanity value per chain (`nativePriceUsdHint` in `src/chains.ts`). Edit when prices move materially.
- **Stable tokens are limited to a small known set** per chain. Profit in an unknown token is dropped.
- **Public RPC rate limits.** The default endpoints work for low-throughput tailing but will throttle on heavy ranges. Set a paid endpoint via env var (Alchemy, QuickNode, DRPC).
- **Sandwich heuristic is conservative** — it requires a profitable back-run leg, so unprofitable / failed sandwiches are not reported.
- **Liquidation list is not exhaustive.** Folks Finance (Monad) and chain-specific lenders are not yet wired in.

## Project structure

```
src/
├── abi.ts        Event-signature constants (Transfer, Swap, LiquidationCall…)
├── chains.ts     Per-chain config: RPC, native wrapped, stables, lenders
├── detect.ts     Detection logic per MEV type
├── scanner.ts    Block fetching + live polling loop
└── index.ts      CLI entry
```

## License

MIT

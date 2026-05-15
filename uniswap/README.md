# Uniswap V4 LP-Sandwich Detector

A focused, **read-only** detector for the delta-based-liquidity sandwich pattern documented in Uniswap's own test suite (`PositionManagerModifyLiquiditiesTest::test_increaseFromDeltasPOC`).

## The pattern

Uniswap V4 introduced new actions that consume settlement-account deltas instead of strict input amounts:

- `MINT_POSITION_FROM_DELTAS`
- `INCREASE_LIQUIDITY_FROM_DELTAS`

These actions are convenient — they let users add liquidity using whatever happened to be in their delta account after prior operations — but they are sandwichable when the user doesn't bracket them with proper slippage / range protection.

Within a single block the attack looks like:

1. **Attacker** front-runs with a swap on pool `P` that shifts the price away from the victim's intended range.
2. **Victim** executes `…_FROM_DELTAS`; their `liquidityDelta` is computed at the now-skewed price, so they deposit more value than they get back as LP exposure.
3. **Attacker** back-runs with the opposite swap on `P`, capturing the imbalance.

On-chain footprint emitted by `PoolManager`:

```
Swap(id=P, sender=…, …)            ← attacker EOA, front-run
ModifyLiquidity(id=P, liquidityDelta=+N, …)   ← victim
Swap(id=P, sender=…, …)            ← attacker EOA, opposite direction
```

## What this detector does

- Subscribes to a chain's V4 `PoolManager` event stream block by block.
- Per pool, finds triplets matching the pattern above.
- Reports each hit with attacker EOA, victim EOA, pool ID, all three tx hashes, and the LP delta magnitude.
- **Does not execute anything.** No on-chain writes, no private keys needed.

Use it to: build telemetry, alert LPs that they're being targeted, contribute data to protocol teams, or measure how big this surface actually is on a given chain.

## Run it

```bash
# Live tail Base
npm run v4-lp -- base

# A specific historical block (great for reproducing a known incident)
npm run v4-lp -- base --mode=block --block=45683524

# Backfill a range
npm run v4-lp -- base --mode=range --from=45680000 --to=45680100 --verbose

# Other chains: only ones with a configured PoolManager in
# uniswap/v4-lp-sandwich.ts::POOL_MANAGER_BY_CHAIN will work.
```

## Supported chains

Right now: **Base**. Add new chains by appending to `POOL_MANAGER_BY_CHAIN` in [v4-lp-sandwich.ts](v4-lp-sandwich.ts) — same shape as the existing entries.

## Empirical finding (Base, recent ~500 blocks)

When first run against Base mainnet, the detector returned **0 hits** over hundreds of blocks. Investigation showed:

- ~1,998 LP-adds emitted by `PoolManager` in the window
- 315 blocks contained both `Swap` and `ModifyLiquidity` events
- 135 structural triplets matched the shape *swap → LP-add → opposite-swap on same pool*
- **All 135 were single-tx batch operations** — one transaction emitting swap + ModifyLiquidity + swap as part of a complex DeFi action (e.g., an LP rebalance that swaps to recenter, modifies liquidity, then swaps back)
- **0 cross-tx sandwich patterns** in that window

In other words: the architectural attack surface from the `…_FROM_DELTAS` actions exists, but in the recent Base sample we measured, **no one is actually exploiting it** at the block-level pattern this detector looks for. That's interesting on its own — it suggests either that V4 periphery contracts and front-ends are setting good slippage protection, or that searcher attention hasn't focused on this surface yet.

The detector correctly rejects single-tx batch ops by requiring the victim's EOA to differ from the front-run/back-run EOA — a key correctness check that the loose-pattern variant we used for validation didn't have.

## What this detector does NOT do

- It does not distinguish *delta-based* LP adds from regular `INCREASE_LIQUIDITY` adds. Both emit the same `ModifyLiquidity` event. A "true" delta-based call would require calldata decoding of the Position Manager. The broader pattern (sandwich around any LP add) is still suspicious regardless, so we surface it.
- It does not estimate the dollar value of the imbalance the attacker captured. That requires the V4 pool's token decimals + current oracle prices.
- It does not catch attacks where the swap legs go through other contracts that don't emit `Swap` on `PoolManager` (e.g. swaps that route via V3 hops first). Pure V4-internal sandwiches only.

## Architecture

```
uniswap/
├── v4-lp-sandwich.ts    Core detector: getLogs + receipt EOA mapping + pattern match
├── scan.ts              CLI: live / range / single-block modes
└── README.md            This file
```

Reuses `src/scanner.ts::fetchBlockWithReceipts` for receipt fetching (with the `eth_getBlockReceipts` fast path) so behavior is consistent with the rest of the project.

## Why we built this (and not the offensive bot)

LP sandwich extraction has identifiable victims — liquidity providers who set insufficient slippage protection. Building the executor automates harm to those specific users. Building the detector contributes defensive telemetry: LPs know they're being targeted, protocol teams can size the problem, and downstream tooling (UIs, slippage warnings, MEV-aware routers) can adapt.

Same plumbing, different intent.

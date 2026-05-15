# Triangular-arb reverse engineering

Read-only tooling to take *executed* on-chain transactions and reconstruct the
arbitrage cycle the searcher ran: which pools, which tokens, which DEX
families, gross profit, gas cost.

Same shape as the V4 LP-sandwich detector — this one is the forward analog for
classic cyclic arbitrage (the 14-of-15-arbs-on-mainnet pattern).

## Three layers

```
arb/
├── events.ts       Family-agnostic Swap decoders (V2 / V3 / V4 / Curve / Balancer V2)
├── resolve.ts      Token-address resolution (pool.token0(), PoolManager.Initialize, coins(i))
├── decode.ts       Receipt → DecodedArb | null   (foundation)
├── scan.ts         Block range / live tail using decoder
├── aggregate.ts    Pattern miner over a list of DecodedArb
└── cli.ts          decode / scan / aggregate modes
```

The decoder is the foundation: it builds a directed token-flow graph from the
swap events in one receipt and looks for a closed cycle whose final output
amount exceeds the initial input amount in the same token. The scanner
applies that decoder to every tx in a block range; the aggregator buckets the
output by searcher / pool / path.

## Run it

```bash
# Decode one tx
npx tsx arb/cli.ts decode 0xf036d8d14c19fa06cb603614363dea3adcf54ec21f199b67f591613882d629df --chain=base

# Backfill a small range
npx tsx arb/cli.ts scan base --from=46028580 --to=46028585 --verbose

# Live tail
npx tsx arb/cli.ts scan base --live

# Scan then aggregate
npx tsx arb/cli.ts aggregate base --from=46028580 --to=46028600
```

## Example output (verified on Base block 46028585)

```
[Base] blk=46028585 0xf036d8d1… searcher=0x14adbc7e… executor=0xb2fdd05e…
       3-hop v3  WETH→EURC→USDC→WETH  gross=+0.000009265 WETH  gas=0.0000104 ETH

Hop breakdown:
  1. [v3] 0xaa5fe7dcc07d…  0.067537912 WETH → 131.033982 EURC
  2. [v3] 0xf39b7c34be14…  131.033982 EURC → 152.422051 USDC
  3. [v3] 0xdbc6998296ca…  152.422051 USDC → 0.067547177 WETH
```

That's the canonical 3-hop triangle: the searcher started with WETH, routed
through two stablecoins, and ended with strictly more WETH than they began.

## What the aggregator surfaces

After scanning a few hundred blocks you get back a structured summary:

- **Top searchers by executor contract.** Sophisticated searchers rotate EOAs
  but reuse the same executor (the EigenPhi data showed 8 EOAs → 1 executor
  ratios). The aggregator groups by `tx.to` and reports `eoaCount` separately
  so you can see how spread-out their key management is.
- **DEX combos.** Per searcher, the most common DEX-family mix they used
  (`v2+v3`, `v3+v4`, `curve+v3`, …). This tells you which DEX surfaces they're
  routing across — a `v4`-heavy searcher is a recent specialist; a
  `v2+v3`-only searcher hasn't migrated yet.
- **Cycle-length histogram.** How many 2-hop vs 3-hop vs N-hop. Most arbs are
  3-hop; the 2-hop bucket is usually peg-driven (USDC/USDbC) and the
  longer-tail buckets reveal stranger strategies.
- **Top pools by hop count.** Which pools are getting hammered as arb legs.
  Useful for "this stableswap pool is constantly the middle of a triangle"
  type observations.
- **Path frequency.** The exact recurring routes — e.g. `WETH→EURC→USDC→WETH`
  appearing 40× in a 500-block window is a real, repeatable opportunity that
  someone has automated.

## What it does *not* do (yet)

- **Coinbase tips (priority bribes)** aren't subtracted from gross profit.
  `gasCostWei` is just `gasUsed * effectiveGasPrice`; sophisticated searchers
  pay the block proposer via a direct ETH transfer to `block.coinbase`, which
  needs trace inspection. Net P&L is therefore an upper bound.
- **Atomic batchers that don't emit Swap events.** Some custom AMMs or batch
  contracts emit their own event shapes. Add their ABIs to `events.ts` to
  cover them.
- **Multi-cycle txs** (one tx running two disjoint arb cycles back-to-back).
  The greedy cycle finder takes the first closed cycle it finds. A future
  pass could split the swap list into connected components.
- **V4 pool resolution is slow on cold cache.** Each unknown bytes32 pool id
  triggers a backward `Initialize` event scan (up to 1M blocks chunked at
  10k). Once cached, repeat hits are free. For long backfills, consider
  pre-warming by running a single bulk `Initialize` scan over the V4
  deployment-to-tip range and saving the result.

## Why this exists

The forward search ([src/triangle.ts](../src/triangle.ts)) finds cycles that
*could* be profitable given current pool states. This module finds cycles
that *were* — extracting the actual on-chain searcher behavior, which is
strictly more informative for understanding the meta:

- The forward search tells you "WETH→EURC→USDC has a 2bps edge right now"
- The reverse decoder tells you "0xb2fdd0… has captured that exact path 47
  times this week, always with a 3-hop V3-only routing, average gross 0.95bps,
  paying a 1.05 gas/gross ratio"

The second tells you whether the strategy is *competitive* and *crowded* —
which the forward search can't see.

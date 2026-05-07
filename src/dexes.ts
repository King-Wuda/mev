import type { Address } from "viem";
import type { ChainKey } from "./chains.js";

export interface TokenConfig {
  symbol: string;
  address: Address;
  decimals: number;
  /** Approximate USD price hint, used to compute trade-size USD value. */
  usdHint: number;
}

export interface V3FactoryConfig {
  name: string;
  factory: Address;
  feeTiers: number[];
}

export interface V4Config {
  name: string;
  /** PoolManager singleton — same address across chains where deployed. */
  poolManager: Address;
  /** Read-only StateView contract for fetching pool state. */
  stateView: Address;
  /** Fee + tickSpacing pairs to probe. Hooks=zero (vanilla pools). */
  feeTickSpacings: Array<{ fee: number; tickSpacing: number }>;
}

/**
 * Curated tokens per chain. Pool discovery iterates pairs of these.
 * Includes long-tail tokens (LSTs, alt stables) for catching the niches
 * top-pair scanners miss — e.g. cbETH/wstETH peg drift, USDC/USDbC arb.
 */
export const TOKENS: Record<ChainKey, TokenConfig[]> = {
  base: [
    // Core
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, usdHint: 2300 },
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, usdHint: 1 },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, usdHint: 95000 },
    // Long-tail stables
    { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, usdHint: 1 },
    { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, usdHint: 1 },
    { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, usdHint: 1 },
    { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6, usdHint: 1.07 },
    // Liquid staking tokens (peg-tracking arb opportunities)
    { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, usdHint: 2400 },
    { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, usdHint: 2750 },
    { symbol: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", decimals: 18, usdHint: 2580 },
    { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18, usdHint: 2425 },
    // DEX governance tokens
    { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, usdHint: 1.2 },
  ],
  berachain: [
    { symbol: "WBERA", address: "0x6969696969696969696969696969696969696969", decimals: 18, usdHint: 5 },
    { symbol: "HONEY", address: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce", decimals: 18, usdHint: 1 },
    // Bridged stables — common Berachain DeFi pairs
    { symbol: "USDC", address: "0x549943e04f40284185054145c6E4e9568C1D3241", decimals: 6, usdHint: 1 },
    { symbol: "BYUSD", address: "0x688e72142674041f8f6Af4c808a4045cA1D6aC82", decimals: 6, usdHint: 1 },
    // Wrapped majors
    { symbol: "WETH", address: "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590", decimals: 18, usdHint: 2300 },
    { symbol: "WBTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", decimals: 8, usdHint: 95000 },
  ],
  monad: [
    { symbol: "WMON", address: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701", decimals: 18, usdHint: 1 },
  ],
  abstract: [
    { symbol: "WETH", address: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809", decimals: 18, usdHint: 2300 },
    { symbol: "USDC", address: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1", decimals: 6, usdHint: 1 },
  ],
  hyperevm: [
    { symbol: "WHYPE", address: "0x5555555555555555555555555555555555555555", decimals: 18, usdHint: 30 },
    { symbol: "USDC", address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", decimals: 6, usdHint: 1 },
  ],
};

/**
 * Uniswap V4 PoolManager + StateView per chain. V4 is a singleton —
 * pools are identified by keccak256(abi.encode(currency0, currency1, fee,
 * tickSpacing, hooks)) rather than per-pool contract addresses.
 *
 * Insight from EigenPhi data: V4 represents ~64% of swap legs in current
 * mainnet arbitrage. A V3-only scanner is blind to two-thirds of the game.
 */
export const V4_CONFIGS: Partial<Record<ChainKey, V4Config>> = {
  base: {
    name: "Uniswap V4",
    poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    feeTickSpacings: [
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ],
  },
};

/**
 * Uniswap V3-style factories per chain. Pool address discovery uses
 * factory.getPool(tokenA, tokenB, fee).
 */
export const V3_FACTORIES: Record<ChainKey, V3FactoryConfig[]> = {
  base: [
    {
      name: "Uniswap V3",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      feeTiers: [100, 500, 3000, 10000],
    },
    {
      name: "PancakeSwap V3",
      factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      feeTiers: [100, 500, 2500, 10000],
    },
  ],
  berachain: [
    {
      // Verified from Kodiak Finance docs at documentation.kodiak.finance
      name: "Kodiak V3",
      factory: "0xD84CBf0B02636E7f53dB9E5e45A616E05d710990",
      feeTiers: [100, 500, 3000, 10000],
    },
  ],
  monad: [],
  abstract: [],
  hyperevm: [
    // TODO: HyperSwap V3 factory address unverified — docs at
    // docs.hyperswap.exchange returned 403 in scraping. Add when confirmed.
  ],
};

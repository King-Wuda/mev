import type { Chain } from "viem";

export type ChainKey = "base" | "monad" | "berachain" | "abstract" | "hyperevm";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: number;
  rpcUrl: string;
  wsUrl?: string;
  nativeWrapped: `0x${string}`;
  nativeSymbol: string;
  nativePriceUsdHint: number;
  stables: Record<string, `0x${string}`>;
  lendingProtocols: { name: string; address: `0x${string}` }[];
  blockTimeSec: number;
}

const env = (k: string, fallback?: string) => process.env[k] ?? fallback;

export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: env("BASE_RPC", "https://base-rpc.publicnode.com")!,
    wsUrl: env("BASE_WS"),
    nativeWrapped: "0x4200000000000000000000000000000000000006",
    nativeSymbol: "ETH",
    nativePriceUsdHint: 2300,
    stables: {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    },
    lendingProtocols: [
      { name: "Aave V3", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
      { name: "Compound V3 USDC", address: "0xb125E6687d4313864e53df431d5425969c15Eb2F" },
      { name: "Moonwell", address: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" },
      { name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
    ],
    blockTimeSec: 2,
  },
  monad: {
    key: "monad",
    name: "Monad",
    chainId: 143,
    rpcUrl: env("MONAD_RPC", "https://rpc.monad.xyz")!,
    wsUrl: env("MONAD_WS"),
    nativeWrapped: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
    nativeSymbol: "MON",
    nativePriceUsdHint: 1,
    stables: {},
    lendingProtocols: [],
    blockTimeSec: 1,
  },
  berachain: {
    key: "berachain",
    name: "Berachain",
    chainId: 80094,
    rpcUrl: env("BERA_RPC", "https://rpc.berachain.com")!,
    wsUrl: env("BERA_WS"),
    nativeWrapped: "0x6969696969696969696969696969696969696969",
    nativeSymbol: "BERA",
    nativePriceUsdHint: 5,
    stables: {
      HONEY: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce",
    },
    lendingProtocols: [],
    blockTimeSec: 2,
  },
  abstract: {
    key: "abstract",
    name: "Abstract",
    chainId: 2741,
    rpcUrl: env("ABSTRACT_RPC", "https://api.mainnet.abs.xyz")!,
    wsUrl: env("ABSTRACT_WS"),
    nativeWrapped: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809",
    nativeSymbol: "ETH",
    nativePriceUsdHint: 2300,
    stables: {
      USDC: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
    },
    lendingProtocols: [],
    blockTimeSec: 1,
  },
  hyperevm: {
    key: "hyperevm",
    name: "Hyperliquid (HyperEVM)",
    chainId: 999,
    rpcUrl: env("HYPEREVM_RPC", "https://rpc.hyperliquid.xyz/evm")!,
    wsUrl: env("HYPEREVM_WS"),
    nativeWrapped: "0x5555555555555555555555555555555555555555",
    nativeSymbol: "HYPE",
    nativePriceUsdHint: 30,
    stables: {
      USDC: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    },
    lendingProtocols: [],
    blockTimeSec: 2,
  },
};

export const ALL_CHAINS: ChainKey[] = ["base", "monad", "berachain", "abstract", "hyperevm"];

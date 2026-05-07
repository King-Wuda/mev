import { keccak256, toBytes } from "viem";

const sig = (s: string) => keccak256(toBytes(s));

export const TOPIC = {
  ERC20_TRANSFER: sig("Transfer(address,address,uint256)"),
  UNI_V2_SWAP: sig("Swap(address,uint256,uint256,uint256,uint256,address)"),
  UNI_V3_SWAP: sig("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  UNI_V4_SWAP: sig("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  UNI_V3_MINT: sig("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  UNI_V3_BURN: sig("Burn(address,int24,int24,uint128,uint256,uint256)"),
  AAVE_V3_LIQUIDATION: sig(
    "LiquidationCall(address,address,address,uint256,uint256,address,bool)"
  ),
  COMPOUND_V3_ABSORB: sig("AbsorbCollateral(address,address,address,uint256,uint256)"),
  MORPHO_LIQUIDATE: sig(
    "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)"
  ),
  COMPOUND_V2_LIQUIDATE: sig(
    "LiquidateBorrow(address,address,uint256,address,uint256)"
  ),
} as const;

export const SWAP_TOPICS: readonly `0x${string}`[] = [
  TOPIC.UNI_V2_SWAP,
  TOPIC.UNI_V3_SWAP,
  TOPIC.UNI_V4_SWAP,
];

export const LIQUIDATION_TOPICS: Record<string, `0x${string}`> = {
  "Aave V3": TOPIC.AAVE_V3_LIQUIDATION,
  "Compound V3": TOPIC.COMPOUND_V3_ABSORB,
  "Morpho Blue": TOPIC.MORPHO_LIQUIDATE,
  "Compound V2": TOPIC.COMPOUND_V2_LIQUIDATE,
};

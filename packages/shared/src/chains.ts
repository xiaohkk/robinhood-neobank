import {defineChain} from "viem";

/// Arc Testnet — Circle's stablecoin-native L1. USDC is the native gas token.
/// RPC/chainId/explorer confirmed from sponsor docs (2026-06).
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {name: "USDC", symbol: "USDC", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.testnet.arc.network"]}},
  blockExplorers: {default: {name: "Arcscan", url: "https://testnet.arcscan.app"}},
  testnet: true,
});

/// Local anvil chain standing in for Arc during development (Arc is EVM-compatible).
export const localArc = defineChain({
  id: 31337,
  name: "Local Arc (anvil)",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["http://127.0.0.1:8545"]}},
  testnet: true,
});

/// Robinhood Chain — Arbitrum Orbit L2, ETH-native gas, Blockscout-verified explorer.
/// Values confirmed against the canonical ethereum-lists/chains registry (eip155-4663 / eip155-46630).
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.mainnet.chain.robinhood.com"]}},
  blockExplorers: {default: {name: "Blockscout", url: "https://robinhoodchain.blockscout.com"}},
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: ["https://rpc.testnet.chain.robinhood.com/rpc"]}},
  blockExplorers: {default: {name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com"}},
  testnet: true,
});

/// Canonical token addresses on Arc. Native gas is USDC (18 dp); the ERC-20 interface is 6 dp.
export const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000" as const;
export const ARC_EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;

/// Paxos USDG on Robinhood Chain *mainnet* (6 dp) — the asset the Bank points at instead of Arc USDC.
/// Documented cutover reference only; testnet uses an env placeholder / mock (see ROBINHOOD-DEPLOY.md).
/// NB: not to be confused with the unrelated 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "USDG".
export const RH_USDG_MAINNET = "0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F" as const;

export const SUPPORTED_CHAINS = {
  arcTestnet,
  robinhoodMainnet,
  robinhoodTestnet,
  localArc,
} as const;

export function chainById(id: number) {
  switch (id) {
    case arcTestnet.id:
      return arcTestnet;
    case robinhoodMainnet.id:
      return robinhoodMainnet;
    case robinhoodTestnet.id:
      return robinhoodTestnet;
    default:
      return localArc;
  }
}

/// Chains where the Chainlink CRE confidential-compliance workflow is available. CRE is confirmed
/// NOT supported on Robinhood Chain (Chainlink lists only CCIP/Data Streams/Data Feeds there), so the
/// PolicyRegistry attestation layer is gated Arc-only. `31337` is the local anvil stand-in for Arc.
export const CRE_CHAIN_IDS: readonly number[] = [arcTestnet.id, 31337];
export function supportsCRE(id: number): boolean {
  return CRE_CHAIN_IDS.includes(id);
}

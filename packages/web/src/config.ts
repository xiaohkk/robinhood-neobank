import {chainById, supportsCRE, ARC_EURC, type Deployment} from "@bankos/shared";
import deploymentJson from "./generated/deployment.json";

export const deployment = deploymentJson as unknown as Deployment;
/** Arc-native EURC, the second supported currency (feature #10). Held privately in the shielded ledger. */
export const EURC_ADDRESS = (deployment.eurc ?? ARC_EURC) as `0x${string}`;
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? deployment.chainId ?? 31337);
export const chain = chainById(CHAIN_ID);
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? chain.rpcUrls.default.http[0];
export const ENGINE_URL = import.meta.env.VITE_ENGINE_URL ?? "http://127.0.0.1:4002";
export const POLICY_URL = import.meta.env.VITE_POLICY_URL ?? "http://127.0.0.1:4001";

/** Set VITE_DYNAMIC_ENVIRONMENT_ID to use Dynamic embedded wallets; otherwise the local dev wallet. */
export const DYNAMIC_ENV_ID = import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID as string | undefined;

/** LI.FI treasury routing is a feature-flagged stretch (see ADR-001). */
export const ENABLE_LIFI = import.meta.env.VITE_ENABLE_LIFI === "true";

/**
 * Whether the Chainlink CRE confidential-compliance workflow is available on the active chain.
 * CRE is confirmed Arc-only — it is NOT supported on Robinhood Chain — so the KYC/attestation flow is
 * gated off there. Auto-detected by chainId (see supportsCRE in @bankos/shared).
 */
export const SUPPORTS_CRE = supportsCRE(CHAIN_ID);

export const isLocal = CHAIN_ID === 31337;

/** Block-explorer URL for a tx (e.g. arcscan on Arc testnet), or undefined on local anvil. */
export function txUrl(hash: string): string | undefined {
  const base = chain.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : undefined;
}

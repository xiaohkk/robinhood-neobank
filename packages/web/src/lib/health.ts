import {publicClient} from "../wallet/WalletContext";
import {POLICY_URL, ENGINE_URL, chain} from "../config";

export interface Health {
  chain: boolean;
  policy: boolean;
  engine: boolean;
  blockNumber?: bigint;
}

async function ok(p: Promise<Response>): Promise<boolean> {
  try {
    return (await p).ok;
  } catch {
    return false;
  }
}

/** Probe the three backends. BankOS is always contract-backed; this shows whether the stack is live. */
export async function getHealth(): Promise<Health> {
  const [block, policy, engine] = await Promise.all([
    publicClient.getBlockNumber().catch(() => undefined),
    ok(fetch(`${POLICY_URL}/health`)),
    ok(fetch(`${ENGINE_URL}/info/environment`)),
  ]);
  return {chain: block !== undefined, policy, engine, blockNumber: block};
}

/** Human label for the active chain (Arc Testnet, Robinhood Chain, local Arc, …). */
export const CHAIN_LABEL = chain.name;

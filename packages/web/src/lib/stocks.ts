import type {Address} from "viem";
import {stockTokensFor, type StockToken} from "@bankos/shared";
import {publicClient} from "../wallet/WalletContext";
import {CHAIN_ID} from "../config";

/**
 * Read-only tokenized-stock holdings (Robinhood Chain). Reads the connected wallet's ERC-20 balances
 * of the faucet stock tokens — no custody, trading, or contract changes. Surfaced only where stock
 * tokens exist for the active chain (see STOCK_TOKENS in @bankos/shared).
 */
const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{name: "owner", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
  },
] as const;

export interface StockHolding extends StockToken {
  balance: bigint;
}

/** Whether the active chain has tokenized stocks to display (drives whether the card renders). */
export const STOCK_TOKENS_AVAILABLE = stockTokensFor(CHAIN_ID).length > 0;

export async function getStockHoldings(owner: Address): Promise<StockHolding[]> {
  const tokens = stockTokensFor(CHAIN_ID);
  return Promise.all(
    tokens.map(async (t) => ({
      ...t,
      balance: (await publicClient.readContract({
        address: t.address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint,
    })),
  );
}

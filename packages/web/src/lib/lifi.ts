import {ARC_USDC_ERC20, ARC_EURC, arcTestnet, robinhoodMainnet, chainById} from "@bankos/shared";
import {createPublicClient, http, type Address, type Hex, type WalletClient} from "viem";

/**
 * LI.FI treasury routing — a feature-flagged stretch (see ADR-001). Fetches an executable swap quote
 * and, behind the flag, signs + broadcasts the returned transactionRequest to rebalance idle reserve.
 * Quoting is parameterized for any src→dst pair; execution is guarded so the connected wallet must be
 * on the route's source chain. Disabled unless VITE_ENABLE_LIFI=true.
 *
 * At hackathon time cross-chain quotes into Arc failed; Robinhood Chain (4663) is now a working LI.FI
 * destination, so it is allow-listed alongside Arc.
 */

/** Chains BankOS will quote/execute LI.FI routes against. Robinhood Chain uses its *mainnet* id (4663);
 *  LI.FI does not index the testnet (46630). */
export const SUPPORTED_LIFI_CHAINS: readonly number[] = [arcTestnet.id, robinhoodMainnet.id];

export interface LifiQuote {
  tool: string; // provider/router that fills the route (e.g. "relay")
  toAmount: string; // estimated output amount (stringified bigint)
  chainId: number; // source chain the transactionRequest must be sent on
  to: Address; // router/contract to call
  data: Hex; // encoded calldata
  value: bigint; // native value to attach (wei)
  gasLimit?: bigint; // suggested gas limit, if LI.FI provided one
}

export type LifiResult<T> = {ok: true; value: T} | {ok: false; error: string};

/** Fetch an executable LI.FI quote for any supported src→dst pair. Returns a typed error (never throws)
 *  for routes LI.FI can't fill, unsupported destinations, or network failures. */
export async function getLifiQuote(params: {
  fromChain: number;
  toChain: number;
  fromToken: Address;
  toToken: Address;
  fromAddress: Address;
  amount: bigint;
}): Promise<LifiResult<LifiQuote>> {
  if (!SUPPORTED_LIFI_CHAINS.includes(params.toChain)) {
    return {ok: false, error: `Destination chain ${params.toChain} is not an allow-listed LI.FI route.`};
  }
  const url =
    `https://li.quest/v1/quote?fromChain=${params.fromChain}&toChain=${params.toChain}` +
    `&fromToken=${params.fromToken}&toToken=${params.toToken}&fromAmount=${params.amount}&fromAddress=${params.fromAddress}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return {ok: false, error: "LI.FI request failed (network)."};
  }
  let j: any;
  try {
    j = await res.json();
  } catch {
    return {ok: false, error: `LI.FI returned a non-JSON response (HTTP ${res.status}).`};
  }
  if (!res.ok) {
    return {ok: false, error: j?.message ? `LI.FI: ${j.message}` : `LI.FI could not fill this route (HTTP ${res.status}).`};
  }
  const txr = j.transactionRequest;
  if (!txr?.to || !txr?.data) {
    return {ok: false, error: j?.message ?? "No executable route available for this pair right now."};
  }
  return {
    ok: true,
    value: {
      tool: j.tool ?? "unknown",
      toAmount: j.estimate?.toAmount ?? "0",
      chainId: Number(txr.chainId ?? params.fromChain),
      to: txr.to as Address,
      data: txr.data as Hex,
      value: txr.value ? BigInt(txr.value) : 0n,
      gasLimit: txr.gasLimit ? BigInt(txr.gasLimit) : undefined,
    },
  };
}

/** Sign + broadcast a LI.FI route with the connected wallet, then wait for the receipt.
 *  Guarded: the wallet must be on the route's source chain, otherwise a clear switch-networks error is
 *  returned (the app's walletClient is bound to a single chain). Never throws. */
export async function executeLifiRoute(walletClient: WalletClient, quote: LifiQuote): Promise<LifiResult<Hex>> {
  const account = walletClient.account;
  if (!account) return {ok: false, error: "No wallet account connected."};

  const walletChainId = walletClient.chain?.id;
  if (walletChainId !== quote.chainId) {
    return {
      ok: false,
      error: `Wallet is on chain ${walletChainId ?? "unknown"}; this route starts on chain ${quote.chainId} — switch networks to execute.`,
    };
  }

  try {
    const hash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: quote.to,
      data: quote.data,
      value: quote.value,
      gas: quote.gasLimit,
    });
    const pub = createPublicClient({chain: chainById(quote.chainId), transport: http()});
    await pub.waitForTransactionReceipt({hash});
    return {ok: true, value: hash};
  } catch (e: any) {
    return {ok: false, error: e?.shortMessage ?? e?.message ?? "Transaction failed."};
  }
}

/** Back-compat helper for the existing same-chain Arc treasury preview (USDC→EURC). */
export async function getArcTreasurySwapQuote(params: {
  fromAddress: Address;
  amount: bigint;
  fromToken?: Address;
  toToken?: Address;
}): Promise<LifiQuote | null> {
  const r = await getLifiQuote({
    fromChain: arcTestnet.id,
    toChain: arcTestnet.id,
    fromToken: params.fromToken ?? ARC_USDC_ERC20,
    toToken: params.toToken ?? ARC_EURC,
    fromAddress: params.fromAddress,
    amount: params.amount,
  });
  return r.ok ? r.value : null;
}

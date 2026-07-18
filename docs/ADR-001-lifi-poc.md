# ADR-001 — LI.FI integration: proof-of-concept result & decision

- **Status:** Accepted
- **Date:** 2026-06-13
- **Context:** The brief asked to *test the LI.FI PoC first, then decide whether to build the
  project with or without it*. The core stack is **Unlink + Chainlink + Dynamic on Arc**;
  Ledger and LI.FI are explicitly "later" / optional. Canton is out of scope.

## What we tested

Run with `node scripts/lifi-poc.mjs` (live calls to `li.quest`). Findings on 2026-06-13:

| Test | Result |
|---|---|
| LI.FI knows Arc | ✅ `Arc` (id `5042`) and `Arc Testnet` (id `5042002`, key `arct`) are in `/v1/chains` |
| Same-chain quote on Arc Testnet (USDC → EURC) | ✅ Returns an executable `transactionRequest` (tool `fly`, ~0.986 EURC per 1 USDC) |
| Cross-chain quote (Arbitrum USDC → Arc Testnet USDC) | ❌ `No available quotes for the requested transfer` |
| `@lifi/composer` npm package | ❌ 404 — Composer is **not** a public npm package |
| Guessed Composer REST endpoints (`/v1/composer`, `/v2/composer/flows`) | ❌ 404 |

## Interpretation

1. **Same-chain Arc routing is real today.** `li.quest` returns ready-to-broadcast calldata for
   an Arc-Testnet USDC→EURC swap. That calldata is exactly what an Unlink **burner** (`fundFromPool`
   → execute swap → `depositToPool`) or a future Unlink `execute()` would wrap to make a treasury
   swap private. The "private DeFi via composed calldata" thesis is therefore **technically valid**.
2. **Composer (the branded product) is not openly distributable.** It appears to be a
   hackathon-provided deployment, not on npm and not on the public `li.quest` API. The public quote
   API is the dependable substitute and already returns the executable Flow calldata we need.
3. **Cross-chain *into* Arc testnet is not routable yet**, so any "fund the bank from another chain"
   story would be unreliable in a live demo.

## Decision

- **Build the core WITHOUT a hard LI.FI dependency.** Core treasury allocation uses the on-chain
  `ExecutionRouter` allow-list + a local `MockYieldVault` (ERC-4626) so the demo is deterministic and
  offline-capable.
- **Ship LI.FI as a feature-flagged "Treasury Routing" *preview* module** (`packages/web/src/lib/lifi.ts`,
  toggled by `VITE_ENABLE_LIFI`). It calls the live quote API for a same-chain Arc swap and **previews** the
  returned executable calldata (tool, est. output, router). The calldata is shaped to be wrapped by an
  Unlink burner (`fundFromPool → swap → depositToPool`), **but that execution path is not yet wired** — the
  module is a route preview only. This keeps the mainline demo off the critical path of an external API or
  unreleased SDK while leaving a clear seam for the burner execution to be added later.
- Revisit cross-chain funding (CCTP/Composer) post-hackathon when Arc-testnet cross-chain liquidity exists.

## Consequence for the architecture

Unlink `execute()` ≈ **BurnerWallet** in the current canary SDK (`@unlink-xyz/sdk@0.0.2-canary.0`):
`fundFromPool → arbitrary DeFi calls → depositToPool`. The treasury-yield feature is designed around
that primitive, with LI.FI calldata as one (optional) source of the "arbitrary DeFi call".

## Addendum — 2026-07 — Robinhood Chain destination + real execution

- **Status:** Accepted (update)
- **Context:** Re-testing `li.quest` showed **Robinhood Chain (`4663`) is now a working LI.FI
  destination** with executable routes (e.g. Arbitrum USDC → Robinhood Chain native ETH via the `Relay`
  provider returns a real `transactionRequest`), unlike the cross-chain-into-Arc dead end from the
  original PoC.

**Changes (`packages/web/src/lib/lifi.ts`):**
- Quoting is generalized to any src→dst pair via `getLifiQuote(...)`, with a `SUPPORTED_LIFI_CHAINS`
  allow-list (Arc `5042002` + Robinhood mainnet `4663`; LI.FI does not index Robinhood **testnet** 46630).
- Added `executeLifiRoute(walletClient, quote)` — it **signs + broadcasts** the returned
  `transactionRequest` and waits for the receipt, replacing the preview-only behavior. It is **guarded**:
  the connected wallet must be on the route's source chain (`transactionRequest.chainId`), otherwise it
  returns a clear "switch to chain X" error. This is because the app's `walletClient` is bound to a single
  chain; funded cross-chain execution requires a wallet on the source chain.
- Error handling returns typed `{ok:false, error}` results (surfacing LI.FI's own message) for routes it
  can't fill, unsupported destinations, or network failures — no more bare `null`.
- The `VITE_ENABLE_LIFI` feature-flag pattern is preserved; the Steward panel gains an "Execute route"
  button behind the flag. `getArcTreasurySwapQuote` remains as a thin back-compat wrapper.

The Unlink-burner wrapping (`fundFromPool → swap → depositToPool`) remains the intended path for making
the treasury swap *private*; direct execution here demonstrates the real broadcast seam.

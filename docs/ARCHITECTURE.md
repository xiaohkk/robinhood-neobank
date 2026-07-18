# BankOS — Architecture

BankOS is a **bank factory**: infrastructure to launch branded, self-custodial, private, compliant
stablecoin banks on Arc. This document explains the layers, the contracts, and the end-to-end flows.

## Supported chains

The contracts are chain-agnostic; chain metadata lives in one place (`packages/shared/src/chains.ts` via
viem `defineChain`) and the app resolves the active chain from `VITE_CHAIN_ID`. Two chains are supported:

| Chain | ID | Native gas | Bank asset | Compliance (Chainlink CRE) |
|---|---|---|---|---|
| **Arc Testnet** | `5042002` | USDC | USDC | ✅ available |
| **Robinhood Chain** (Orbit L2) | `4663` mainnet / `46630` testnet | ETH | Paxos USDG | ❌ **not supported** (Arc-only) |

Adding Robinhood Chain required **no contract changes** — only chain config + deploy env (asset = Paxos
USDG, an allow-listed Morpho ERC-4626 vault). See [`ROBINHOOD-DEPLOY.md`](./ROBINHOOD-DEPLOY.md). Arc
remains fully supported; both are selectable via the existing config pattern.

**Capability gating:** Chainlink CRE is confirmed Arc-only, so `supportsCRE(chainId)` (in
`@bankos/shared`) gates the confidential-compliance layer off on Robinhood Chain — the web Compliance card
stubs out and the `cre-policy` attester fails fast there rather than pretending to run.

## Layered design

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  UX shell — Dynamic embedded wallets (passkey onboarding, non-custodial)        │
│  packages/web : Operator console · Member app · Steward treasury desk           │
└───────────────┬──────────────────────────────┬───────────────────────────────-┘
                │ viem                          │ @unlink-xyz/sdk
                ▼                               ▼
┌───────────────────────────────────┐  ┌────────────────────────────────────────┐
│  Settlement & policy — Arc (EVM)   │  │  Privacy — Unlink                        │
│                                    │  │  packages/unlink-engine                  │
│  CharterFactory ─clone─▶ Bank      │  │  • unlink1… accounts, EdDSA, poseidon    │
│  PolicyRegistry  ExecutionRouter   │  │  • shielded ledger (off-chain transfers) │
│  PrivacyPool   MockUSDC/YieldVault │◀─┤  • relayer settles PrivacyPool withdraws │
└───────▲────────────────────────────┘  └────────────────────────────────────────┘
        │ attest() / onReport()  (on-chain state change)
┌───────┴───────────────────────────┐
│  Compliance — Chainlink CRE        │  Confidential HTTP KYC/sanctions in a TEE →
│  packages/cre-policy               │  DON report → PolicyRegistry. Raw PII never on-chain.
└────────────────────────────────────┘
```

## Contracts (`packages/contracts`)

| Contract | Responsibility |
|---|---|
| `CharterFactory` | Charters banks as minimal-proxy (`LibClone`) clones; registry of all banks + per-steward index. |
| `Bank` | Per-bank state: public deposits, delayed withdrawals, policy-gated credit lines, treasury routing into allow-listed ERC-4626 strategies, risk caps, pause, member→Unlink-account pointer. Steward sets policy; never takes custody of member keys. |
| `PolicyRegistry` | Stores Chainlink-attested eligibility (`tier`, `canDeposit`, `canBorrow`, `jurisdiction`, `expiry`). Writable only by authorized attesters via `attest()` or the CRE forwarder via `onReport()`. |
| `ExecutionRouter` | Protocol allow-list of `(target, selector)` pairs a steward may invoke for treasury actions — bounds the steward to vetted strategies. |
| `PrivacyPool` | Shielded escrow for the Unlink layer: `deposit(commitment, amount)` shields USDC; `withdraw()` is relayer-authorized; nullifiers prevent double-spend. |
| `CharterTypes` | Shared `Products` / `RiskConfig` / `Policy` structs (the "RiskConfig module"). |
| mocks | `MockUSDC` (6-dp faucet), `MockYieldVault` (ERC-4626 strategy with `accrue`). |

35 Foundry tests cover factory/clone, policy gating + expiry + revoke + `onReport`, deposit caps,
delayed withdrawals, credit limits + utilization, treasury allow-listing + yield accrual, pause, and
the privacy pool.

## Key flows

### 1. Charter a bank
`steward → CharterFactory.charterBank(name, brand, products, risk)` → clones `Bank`, initializes it
with the shared `PolicyRegistry` + `ExecutionRouter`, and indexes it. Emits `BankChartered`.

### 2. Onboard a member (compliance)
`member → web KYC form → POST /apply (cre-policy)`. The service runs the confidential eligibility
check (sanctions / jurisdiction / age / ID) — in production inside a CRE TEE via **Confidential HTTP**,
locally in the DON simulator. On approval it lands a `Policy` on-chain:
- local: `PolicyRegistry.attest(bank, member, policy)` signed by the attester key.
- production: the CRE workflow `runtime.report → evm.writeReport → PolicyRegistry.onReport`.

Only the policy (tier/booleans/jurisdiction/expiry) is on-chain — **never PII**.

### 3. Public checking
`member → approve USDC → Bank.deposit(amount)` (gated by `PolicyRegistry.isEligibleToDeposit` + caps).
Withdrawals are `requestWithdraw → (delay) → claimWithdraw`, with `cancelWithdraw`.

### 4. Private balance (Unlink)
The member derives a real `unlink1…` account from a wallet signature. Then:
- **shield**: `PrivacyPool.deposit(commitment, amount)` on-chain → engine credits the shielded balance.
- **private transfer**: EdDSA-signed, applied **off-chain** in the engine — never hits the chain.
- **withdraw**: EdDSA-signed → engine relayer calls `PrivacyPool.withdraw(to, amount, nullifier)`.

On-chain observers see deposits and withdrawals but not internal transfers, per-user balances, or the
deposit↔withdrawal linkage.

### 5. Credit
`steward → Bank.openCreditLine(member, limit)` (≤ per-borrower cap). `member → Bank.borrow(amount)`
gated by `isEligibleToBorrow`, the line, the portfolio utilization cap, and available liquidity.
`Bank.repay(member, amount)` reduces debt.

### 6. Treasury yield
`steward → Bank.allocateToStrategy(vault, assets)` — requires `vault`'s `deposit` selector to be
allow-listed in `ExecutionRouter`. `redeemFromStrategy(vault, shares)` pulls funds back; `totalAssets`
reflects accrued yield. Behind the `VITE_ENABLE_LIFI` flag, the LI.FI module fetches an executable swap
quote and can **sign + broadcast** it (guarded so the wallet must be on the route's source chain);
Robinhood Chain is now a supported LI.FI destination (ADR-001).

## Why self-custodial / not "a bank"

Members hold their own EVM keys (Dynamic embedded wallet) and their own Unlink spending key. The
steward configures policy and risk but cannot move member funds arbitrarily — credit is capped, treasury
is allow-listed, and withdrawals are member-initiated. BankOS is *banking infrastructure*, not an
FDIC-insured deposit bank.

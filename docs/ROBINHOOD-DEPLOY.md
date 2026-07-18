# Robinhood Chain deployment

BankOS supports **Robinhood Chain** as a second chain alongside Arc, using the same chain-config
pattern (`packages/shared/src/chains.ts`) and the *unchanged* Foundry contracts — Robinhood support is
deploy-config only, no contract code changes. This doc covers deploying the Charter stack to **Robinhood
Chain Testnet** and the mainnet cutover addresses.

> **Unaudited hackathon code.** Nothing here is production-audited. Deploy to testnet; treat mainnet
> addresses as reference for a future cutover only.

## Chain parameters

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | `46630` | `4663` |
| Native gas | **ETH** (Sepolia ETH on testnet) | **ETH** |
| RPC | `https://rpc.testnet.chain.robinhood.com/rpc` | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer (Blockscout) | `https://explorer.testnet.chain.robinhood.com` | `https://robinhoodchain.blockscout.com` |
| Type | Arbitrum Orbit L2 | Arbitrum Orbit L2 |

Values confirmed against the canonical `ethereum-lists/chains` registry (`eip155-4663` / `eip155-46630`).
Unlike Arc (which pays gas in USDC), **Robinhood Chain pays gas in ETH** — the deployer must be funded
with testnet ETH.

## ⚠️ Chainlink CRE is Arc-only — NOT available on Robinhood Chain

The confidential-compliance layer (`packages/cre-policy` → `PolicyRegistry`) runs on **Chainlink CRE**,
which is confirmed **not supported on Robinhood Chain** (Chainlink lists only CCIP / Data Streams / Data
Feeds there, per its CRE Supported Networks docs — Arc Testnet is listed, Robinhood Chain is not). BankOS
gates this automatically:

- `supportsCRE(chainId)` in `@bankos/shared` returns `false` for Robinhood Chain.
- The web Compliance card shows a "CRE unavailable on this chain" stub instead of the KYC form.
- The `cre-policy` attester **fails fast** if pointed at a non-CRE chain.

`PolicyRegistry` still deploys and works mechanically (its `attest()` is an owner/attester write), but no
CRE confidential workflow runs on Robinhood Chain. Do **not** represent CRE compliance as active there.

## Asset & yield config

The Bank speaks generic ERC-20 / ERC-4626, so pointing it at a different asset/vault is **deploy-config,
not a code change** — via env vars in `script/Deploy.s.sol`:

| Env var | Meaning | Mainnet reference |
|---|---|---|
| `ASSET_ADDRESS` | Bank reserve asset (falls back to `USDC_ADDRESS` for Arc) | **Paxos USDG** `0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F` (6 dp) |
| `MORPHO_VAULT` | ERC-4626 yield vault to allow-list in `ExecutionRouter` | **Morpho "Steakhouse USDG"** `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` |

> The mainnet USDG is **not** the unrelated token at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
> The Steakhouse USDG vault is curated by Steakhouse Financial and backs Robinhood's live "Earn" product.

**Testnet caveat:** there is no confirmed public deployment of USDG or the Morpho vault on chain `46630`
(LI.FI does not even index the testnet). Leave `ASSET_ADDRESS` / `MORPHO_VAULT` **unset** on testnet and
the deploy script falls back to a `MockUSDC` faucet + `MockYieldVault` (clearly mocks). Swap in the real
mainnet addresses only at cutover.

## Deploy

1. Create `.secrets/robinhood-deployer.env` (gitignored), mirroring the Arc flow:
   ```bash
   DEPLOYER_ADDRESS=0x...
   PRIVATE_KEY=0x...
   # optional — omit on testnet to use mocks:
   # ASSET_ADDRESS=0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F
   # MORPHO_VAULT=0xBeEff033F34C046626B8D0A041844C5d1A5409dd
   ```
2. **Fund `DEPLOYER_ADDRESS` with Robinhood-testnet ETH** (gas is ETH, not USDC).
3. Run:
   ```bash
   bash scripts/deploy-robinhood.sh
   ```
   which balance-checks, runs `forge script script/Deploy.s.sol:Deploy --rpc-url … --broadcast --slow`,
   attempts Blockscout verification, writes `packages/contracts/deployments/46630.json`, and syncs it
   into the web app (`CHAIN_ID=46630 node scripts/sync-web.mjs`).

### Simulate without broadcasting

```bash
cd packages/contracts
forge script script/Deploy.s.sol:Deploy --rpc-url robinhood_testnet
```

### Verify on Blockscout

Inline verification is attempted by the deploy script (`--verify --verifier blockscout`). If it's skipped
or flaky, verify per-contract (per Robinhood's Foundry deploy docs):

```bash
forge verify-contract <address> src/PolicyRegistry.sol:PolicyRegistry \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api \
  --chain 46630
```

The `robinhood_testnet` / `robinhood_mainnet` RPC and `[etherscan]` verifier entries live in
`packages/contracts/foundry.toml`.

## Run against Robinhood Chain in the web app

Point the frontend at the chain via env (existing pattern — no code change):

```
VITE_CHAIN_ID=46630
VITE_RPC_URL=https://rpc.testnet.chain.robinhood.com/rpc
```

The chain object, RPC, explorer links, and CRE gating all resolve automatically from `chainById` /
`supportsCRE`. **Arc remains fully supported** — select it with `VITE_CHAIN_ID=5042002`.

## Fork test

A Robinhood Testnet fork smoke test lives at `packages/contracts/test/RobinhoodFork.t.sol` (gated behind
`RH_FORK` so offline runs skip it):

```bash
RH_FORK=true forge test --match-contract RobinhoodFork -vvv
```

It forks chain `46630`, deploys the stack with mocks, and runs deposit → allocate → redeem to prove the
unchanged contracts execute under Robinhood's ETH-gas environment.

#!/usr/bin/env bash
# Deploy the Charter stack to Robinhood Chain Testnet (chainId 46630).
# Robinhood Chain is an Arbitrum Orbit L2 with ETH-native gas, so the deployer must be funded with
# testnet ETH (unlike Arc, which pays gas in USDC). One account serves as deployer + attester +
# engine relayer, mirroring the Arc flow. Run AFTER funding the address in .secrets/robinhood-deployer.env.
#
#   bash scripts/deploy-robinhood.sh
#
# Asset / yield config (optional env, set in .secrets/robinhood-deployer.env or inline):
#   ASSET_ADDRESS  - the Bank's reserve asset. On mainnet this is Paxos USDG
#                    (0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F, 6 dp). No confirmed testnet USDG
#                    deployment — leave unset to deploy a MockUSDC faucet for the demo.
#   MORPHO_VAULT   - an ERC-4626 Morpho vault to allow-list as a treasury strategy. On mainnet the
#                    Steakhouse USDG vault is 0xBeEff033F34C046626B8D0A041844C5d1A5409dd. Leave unset
#                    on testnet to deploy + allow-list a MockYieldVault instead.
#
# NOTE: Chainlink CRE is Arc-only — it is NOT available on Robinhood Chain. PolicyRegistry still
# deploys (owner-controlled attester), but the confidential-compliance workflow does not run here.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .secrets/robinhood-deployer.env ] || { echo "missing .secrets/robinhood-deployer.env"; exit 1; }
set -a; source .secrets/robinhood-deployer.env; set +a

RPC="${ROBINHOOD_RPC_URL:-https://rpc.testnet.chain.robinhood.com/rpc}"
CHAIN_ID=46630
VERIFIER_URL="${ROBINHOOD_VERIFIER_URL:-https://explorer.testnet.chain.robinhood.com/api}"
echo "▸ Deployer: $DEPLOYER_ADDRESS"
echo "▸ RPC:      $RPC"
BAL=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "▸ Balance:  $BAL wei (ETH)"
if [ "$BAL" = "0" ]; then
  echo "!! Deployer has 0 balance — fund $DEPLOYER_ADDRESS with Robinhood-testnet ETH first (see docs/ROBINHOOD-DEPLOY.md)."
  exit 1
fi

echo "▸ Deploying contracts to Robinhood Chain Testnet…"
( cd packages/contracts && forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC" --broadcast --slow \
    --verify --verifier blockscout --verifier-url "$VERIFIER_URL" )

echo "▸ Exporting ABIs + syncing web deployment for chain $CHAIN_ID…"
node scripts/export-abis.mjs >/dev/null
CHAIN_ID=$CHAIN_ID node scripts/sync-web.mjs

echo
echo "✅ Robinhood Chain Testnet deployment complete. Addresses in packages/contracts/deployments/$CHAIN_ID.json"
cat "packages/contracts/deployments/$CHAIN_ID.json"
echo
echo "If inline --verify was skipped/flaky, verify per-contract with Blockscout, e.g.:"
echo "  forge verify-contract <addr> src/PolicyRegistry.sol:PolicyRegistry \\"
echo "    --verifier blockscout --verifier-url $VERIFIER_URL --chain $CHAIN_ID"

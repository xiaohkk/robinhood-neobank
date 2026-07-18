// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CharterFactory} from "../src/CharterFactory.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {ExecutionRouter} from "../src/ExecutionRouter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockYieldVault} from "../src/mocks/MockYieldVault.sol";
import {PrivacyPool} from "../src/PrivacyPool.sol";
import {IERC4626} from "../src/interfaces/IExternal.sol";

/// @notice Deploys the full Charter stack and writes addresses to deployments/<chainId>.json.
///
/// Env vars (all optional):
///   PRIVATE_KEY   - deployer key (defaults to anvil account #0 if unset)
///   ATTESTER      - the Chainlink CRE forwarder address authorized to write policy
///                   (defaults to anvil account #1). NB: CRE is Arc-only; on Robinhood Chain this is
///                   just an owner-controlled key, not a live CRE forwarder.
///   ASSET_ADDRESS - the Bank's reserve asset (generic ERC-20). Preferred key; falls back to
///                   USDC_ADDRESS for Arc back-compat. On Robinhood Chain set this to Paxos USDG.
///   USDC_ADDRESS  - legacy alias for ASSET_ADDRESS (use 0x3600... on Arc). If both unset/zero a
///                   MockUSDC is deployed.
///   MORPHO_VAULT  - an existing ERC-4626 yield vault to allow-list (e.g. a Morpho vault on Robinhood
///                   Chain). If unset/zero a MockYieldVault is deployed and allow-listed instead.
contract Deploy is Script {
    // anvil default accounts
    uint256 constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ANVIL_ACCT1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // attester
    address constant ANVIL_ACCT5 = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // unlink engine relayer

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address deployer = vm.addr(pk);
        address attester = vm.envOr("ATTESTER", ANVIL_ACCT1);
        address engineRelayer = vm.envOr("ENGINE_RELAYER", ANVIL_ACCT5);
        // ASSET_ADDRESS is the generic Bank reserve asset; USDC_ADDRESS is the legacy Arc alias.
        address usdcAddr = vm.envOr("ASSET_ADDRESS", vm.envOr("USDC_ADDRESS", address(0)));
        address morphoVault = vm.envOr("MORPHO_VAULT", address(0));

        vm.startBroadcast(pk);

        if (usdcAddr == address(0)) {
            usdcAddr = address(new MockUSDC());
        }

        PolicyRegistry policy = new PolicyRegistry(deployer, attester);
        ExecutionRouter router = new ExecutionRouter(deployer);
        CharterFactory factory = new CharterFactory(deployer, usdcAddr, address(policy), address(router));

        // Yield strategy allow-listed for steward treasury routing. Prefer a real ERC-4626 vault
        // (e.g. a Morpho vault on Robinhood Chain) when MORPHO_VAULT is set; otherwise deploy a mock.
        address vaultAddr = morphoVault;
        if (vaultAddr == address(0)) {
            vaultAddr = address(new MockYieldVault(usdcAddr));
        }
        router.setAllowed(vaultAddr, IERC4626.deposit.selector, true);
        router.setAllowed(vaultAddr, IERC4626.redeem.selector, true);

        // Shielded pool for the Unlink privacy layer (engine settles withdrawals).
        PrivacyPool pool = new PrivacyPool(deployer, usdcAddr, engineRelayer);

        vm.stopBroadcast();

        console2.log("USDC            ", usdcAddr);
        console2.log("PolicyRegistry  ", address(policy));
        console2.log("ExecutionRouter ", address(router));
        console2.log("CharterFactory  ", address(factory));
        console2.log("BankImpl        ", factory.bankImplementation());
        console2.log("YieldVault      ", vaultAddr);
        console2.log("PrivacyPool     ", address(pool));
        console2.log("Attester        ", attester);
        console2.log("EngineRelayer   ", engineRelayer);

        _writeJson(
            Addrs({
                usdc: usdcAddr,
                policy: address(policy),
                router: address(router),
                factory: address(factory),
                bankImpl: factory.bankImplementation(),
                vault: vaultAddr,
                pool: address(pool),
                attester: attester,
                engineRelayer: engineRelayer
            })
        );
    }

    struct Addrs {
        address usdc;
        address policy;
        address router;
        address factory;
        address bankImpl;
        address vault;
        address pool;
        address attester;
        address engineRelayer;
    }

    function _writeJson(Addrs memory a) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", a.usdc);
        vm.serializeAddress(o, "policyRegistry", a.policy);
        vm.serializeAddress(o, "executionRouter", a.router);
        vm.serializeAddress(o, "charterFactory", a.factory);
        vm.serializeAddress(o, "bankImplementation", a.bankImpl);
        vm.serializeAddress(o, "yieldVault", a.vault);
        vm.serializeAddress(o, "privacyPool", a.pool);
        vm.serializeAddress(o, "engineRelayer", a.engineRelayer);
        string memory json = vm.serializeAddress(o, "attester", a.attester);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CharterTestBase} from "./Charter.t.sol";
import {Bank} from "../src/Bank.sol";

/// @notice Fork smoke test against Robinhood Chain Testnet (chainId 46630).
///
/// The Charter contracts are chain-agnostic and require no changes for Robinhood Chain, so this test
/// deploys the full stack onto a live fork (via the mock asset + mock ERC-4626 vault from
/// CharterTestBase — real testnet USDG / Morpho vaults are not confirmed deployed on 46630) and runs a
/// deposit → allocate → redeem flow to prove the unchanged contracts execute under Robinhood's
/// ETH-native-gas environment.
///
/// The `attester` here is a test stand-in — Chainlink CRE is Arc-only and does NOT run on Robinhood
/// Chain, so on a real Robinhood deployment PolicyRegistry attestations come from an owner key, not CRE.
///
/// Gated behind RH_FORK so the default `forge test` (offline / CI) skips it cleanly:
///   RH_FORK=true forge test --match-contract RobinhoodFork -vvv
/// Requires the `robinhood_testnet` RPC endpoint (foundry.toml) to be reachable.
contract RobinhoodForkTest is CharterTestBase {
    uint256 constant RH_TESTNET_CHAIN_ID = 46630;
    bool forked;

    function setUp() public override {
        // Only fork when explicitly enabled, so runs without network access skip instead of failing.
        try vm.envBool("RH_FORK") returns (bool on) {
            if (on) {
                vm.createSelectFork(vm.rpcUrl("robinhood_testnet"));
                forked = true;
            }
        } catch {}
        super.setUp();
    }

    function test_chainId_isRobinhoodTestnet() public {
        if (!forked) return vm.skip(true);
        assertEq(block.chainid, RH_TESTNET_CHAIN_ID);
    }

    function test_charterDepositAllocateRedeem_onFork() public {
        if (!forked) return vm.skip(true);

        Bank bank = _charter();
        _attestDeposit(address(bank), alice, true, false);

        vm.startPrank(alice);
        usdc.approve(address(bank), type(uint256).max);
        bank.deposit(100_000 * USDC);
        vm.stopPrank();
        assertEq(bank.depositOf(alice), 100_000 * USDC);

        // Route treasury into the allow-listed vault and back out — the ExecutionRouter allow-list and
        // ERC-4626 integration must work identically on Robinhood Chain.
        vm.prank(steward);
        bank.allocateToStrategy(address(vault), 40_000 * USDC);
        assertApproxEqAbs(bank.strategyAssets(), 40_000 * USDC, 1);
        assertEq(bank.idleLiquidity(), 60_000 * USDC);

        uint256 shares = bank.sharesOf(address(vault));
        vm.prank(steward);
        bank.redeemFromStrategy(address(vault), shares);
        assertApproxEqAbs(bank.idleLiquidity(), 100_000 * USDC, 1);
    }
}

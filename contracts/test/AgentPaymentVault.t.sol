// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentPaymentVault} from "../src/AgentPaymentVault.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {CounterMock} from "./mocks/CounterMock.sol";
import {MockDEX} from "./mocks/MockDEX.sol";

contract AgentPaymentVaultTest is Test {
    AgentPaymentVault vault;
    ERC20Mock usdc;
    ERC20Mock weth;
    CounterMock counter;
    MockDEX dex;

    address owner = address(this);
    address sessionKey1 = vm.addr(1);
    address sessionKey2 = vm.addr(2);
    address vendor = address(0xBEEF);
    address randomAddr = address(0xDEAD);

    uint256 constant MAX_PER_TX = 2_000_000; // 2 USDC
    uint256 constant MAX_TOTAL = 50_000_000; // 50 USDC
    uint256 constant EXPIRY = 7 days;

    function setUp() public {
        vault = new AgentPaymentVault();
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped ETH", "WETH", 18);
        counter = new CounterMock();
        dex = new MockDEX();

        // Fund vault with 100 USDC
        usdc.mint(owner, 100_000_000);
        usdc.approve(address(vault), 100_000_000);
        vault.deposit(address(usdc), 100_000_000);

        // Register session key 1
        vault.registerSessionKey(
            sessionKey1,
            MAX_PER_TX,
            MAX_TOTAL,
            block.timestamp + EXPIRY,
            vendor,
            address(usdc)
        );
    }

    // ── Registration ────────────────────────────────────────────────

    function test_registerSessionKey() public view {
        AgentPaymentVault.SessionPermission memory perm = vault.getSessionPermission(sessionKey1);
        assertEq(perm.maxPerTx, MAX_PER_TX);
        assertEq(perm.maxTotal, MAX_TOTAL);
        assertEq(perm.spent, 0);
        assertEq(perm.allowedRecipient, vendor);
        assertEq(perm.allowedToken, address(usdc));
        assertTrue(perm.exists);
        assertFalse(perm.revoked);
    }

    function test_revert_duplicateRegistration() public {
        vm.expectRevert(AgentPaymentVault.SessionAlreadyExists.selector);
        vault.registerSessionKey(sessionKey1, MAX_PER_TX, MAX_TOTAL, block.timestamp + EXPIRY, vendor, address(usdc));
    }

    // ── Payment execution ───────────────────────────────────────────

    function test_executePayment() public {
        vm.prank(sessionKey1);
        vault.executePayment(address(usdc), vendor, 500_000);

        assertEq(usdc.balanceOf(vendor), 500_000);
        AgentPaymentVault.SessionPermission memory perm = vault.getSessionPermission(sessionKey1);
        assertEq(perm.spent, 500_000);
    }

    function test_revert_exceedsPerTxLimit() public {
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.ExceedsPerTxLimit.selector, 3_000_000, MAX_PER_TX)
        );
        vault.executePayment(address(usdc), vendor, 3_000_000);
    }

    function test_revert_exceedsTotalLimit() public {
        // Spend up to near limit
        for (uint256 i = 0; i < 25; i++) {
            vm.prank(sessionKey1);
            vault.executePayment(address(usdc), vendor, 2_000_000);
        }
        // Next should exceed total
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.ExceedsTotalLimit.selector, 52_000_000, MAX_TOTAL)
        );
        vault.executePayment(address(usdc), vendor, 2_000_000);
    }

    function test_revert_recipientNotAllowed() public {
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.RecipientNotAllowed.selector, randomAddr)
        );
        vault.executePayment(address(usdc), randomAddr, 500_000);
    }

    function test_revert_tokenNotAllowed() public {
        ERC20Mock otherToken = new ERC20Mock("Other", "OTH", 18);
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.TokenNotAllowed.selector, address(otherToken))
        );
        vault.executePayment(address(otherToken), vendor, 500_000);
    }

    function test_revert_sessionExpired() public {
        vm.warp(block.timestamp + EXPIRY + 1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionExpired.selector);
        vault.executePayment(address(usdc), vendor, 500_000);
    }

    function test_revert_sessionRevoked() public {
        vault.revokeSessionKey(sessionKey1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionRevoked.selector);
        vault.executePayment(address(usdc), vendor, 500_000);
    }

    function test_revert_unknownSessionKey() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.SessionNotFound.selector);
        vault.executePayment(address(usdc), vendor, 500_000);
    }

    // ── Rotation ────────────────────────────────────────────────────

    function test_rotateSessionKey() public {
        vault.rotateSessionKey(
            sessionKey1,
            sessionKey2,
            MAX_PER_TX,
            MAX_TOTAL,
            block.timestamp + EXPIRY,
            vendor,
            address(usdc)
        );

        // Old key revoked
        AgentPaymentVault.SessionPermission memory oldPerm = vault.getSessionPermission(sessionKey1);
        assertTrue(oldPerm.revoked);

        // New key works
        vm.prank(sessionKey2);
        vault.executePayment(address(usdc), vendor, 500_000);
        assertEq(usdc.balanceOf(vendor), 500_000);
    }

    // ── Self-rotation ───────────────────────────────────────────────

    function test_selfRotate() public {
        // sessionKey1 spends some first
        vm.prank(sessionKey1);
        vault.executePayment(address(usdc), vendor, 1_000_000);

        // sessionKey1 self-rotates to sessionKey2
        vm.prank(sessionKey1);
        vault.selfRotate(sessionKey2);

        // Old key is revoked
        AgentPaymentVault.SessionPermission memory oldPerm = vault.getSessionPermission(sessionKey1);
        assertTrue(oldPerm.revoked);

        // New key inherits spent
        AgentPaymentVault.SessionPermission memory newPerm = vault.getSessionPermission(sessionKey2);
        assertEq(newPerm.spent, 1_000_000);
        assertEq(newPerm.maxPerTx, MAX_PER_TX);
        assertEq(newPerm.maxTotal, MAX_TOTAL);
        assertEq(newPerm.allowedRecipient, vendor);
        assertEq(newPerm.allowedToken, address(usdc));
        assertFalse(newPerm.revoked);

        // New key can pay
        vm.prank(sessionKey2);
        vault.executePayment(address(usdc), vendor, 500_000);
        assertEq(usdc.balanceOf(vendor), 1_500_000);
    }

    function test_revert_selfRotate_revokedKey() public {
        vault.revokeSessionKey(sessionKey1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionRevoked.selector);
        vault.selfRotate(sessionKey2);
    }

    function test_revert_selfRotate_expiredKey() public {
        vm.warp(block.timestamp + EXPIRY + 1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionExpired.selector);
        vault.selfRotate(sessionKey2);
    }

    function test_revert_selfRotate_duplicateNewKey() public {
        // Register sessionKey2 first
        vault.registerSessionKey(sessionKey2, MAX_PER_TX, MAX_TOTAL, block.timestamp + EXPIRY, vendor, address(usdc));
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionAlreadyExists.selector);
        vault.selfRotate(sessionKey2);
    }

    // ── Pause ───────────────────────────────────────────────────────

    function test_pause_blocksPayments() public {
        vault.pause();
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.Paused.selector);
        vault.executePayment(address(usdc), vendor, 500_000);
    }

    function test_unpause_allowsPayments() public {
        vault.pause();
        vault.unpause();
        vm.prank(sessionKey1);
        vault.executePayment(address(usdc), vendor, 500_000);
        assertEq(usdc.balanceOf(vendor), 500_000);
    }

    // ── Access control ──────────────────────────────────────────────

    function test_revert_nonOwnerRegister() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.registerSessionKey(sessionKey2, MAX_PER_TX, MAX_TOTAL, block.timestamp + EXPIRY, vendor, address(usdc));
    }

    function test_revert_nonOwnerRevoke() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.revokeSessionKey(sessionKey1);
    }

    function test_revert_nonOwnerPause() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.pause();
    }

    // ── Withdraw ────────────────────────────────────────────────────

    function test_ownerWithdraw() public {
        vault.withdraw(address(usdc), owner, 50_000_000);
        assertEq(usdc.balanceOf(owner), 50_000_000);
        assertEq(vault.getVaultBalance(address(usdc)), 50_000_000);
    }

    // ── executeCall ─────────────────────────────────────────────────

    function _setupExecuteCall() internal {
        // Add counter as allowed target for sessionKey1
        vault.addAllowedTarget(sessionKey1, address(counter));
        // Whitelist increment() and add(uint256) selectors
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.increment.selector);
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.add.selector);
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.payableIncrement.selector);
    }

    function test_executeCall_increment() public {
        _setupExecuteCall();
        vm.prank(sessionKey1);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
        assertEq(counter.count(), 1);
    }

    function test_executeCall_withArgs() public {
        _setupExecuteCall();
        vm.prank(sessionKey1);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.add, (42)));
        assertEq(counter.count(), 42);
    }

    function test_executeCall_withValue() public {
        _setupExecuteCall();
        // Fund the vault with MON
        vm.deal(address(vault), 10 ether);
        vm.prank(sessionKey1);
        // Use value within maxPerTx (2_000_000)
        vault.executeCall(address(counter), 1_000_000, abi.encodeCall(CounterMock.payableIncrement, ()));
        assertEq(counter.count(), 1);
        assertEq(counter.lastValue(), 1_000_000);
    }

    function test_revert_executeCall_targetNotAllowed() public {
        // Don't add counter as allowed target
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.increment.selector);
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.TargetNotAllowed.selector, address(counter))
        );
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
    }

    function test_revert_executeCall_selectorNotAllowed() public {
        vault.addAllowedTarget(sessionKey1, address(counter));
        // Only whitelist increment, not reset
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.increment.selector);
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.SelectorNotAllowed.selector, CounterMock.reset.selector)
        );
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.reset, ()));
    }

    function test_revert_executeCall_selfCall() public {
        vault.addAllowedTarget(sessionKey1, address(vault));
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SelfCallNotAllowed.selector);
        vault.executeCall(address(vault), 0, abi.encodeCall(AgentPaymentVault.pause, ()));
    }

    function test_revert_executeCall_approveBlacklist() public {
        vault.addAllowedTarget(sessionKey1, address(usdc));
        // Whitelist approve selector — should still be blocked by blacklist
        bytes4 approveSelector = bytes4(keccak256("approve(address,uint256)"));
        vault.addAllowedSelector(sessionKey1, address(usdc), approveSelector);
        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.SelectorNotAllowed.selector, approveSelector)
        );
        vault.executeCall(address(usdc), 0, abi.encodeWithSelector(approveSelector, address(0xBEEF), 100));
    }

    function test_revert_executeCall_valueExceedsPerTxLimit() public {
        _setupExecuteCall();
        vm.deal(address(vault), 100 ether);
        vm.prank(sessionKey1);
        // maxPerTx = 2_000_000 (wei in this context)
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.ValueExceedsPerTxLimit.selector, 3_000_000, MAX_PER_TX)
        );
        vault.executeCall(address(counter), 3_000_000, abi.encodeCall(CounterMock.payableIncrement, ()));
    }

    function test_revert_executeCall_sessionExpired() public {
        _setupExecuteCall();
        vm.warp(block.timestamp + EXPIRY + 1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionExpired.selector);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
    }

    function test_revert_executeCall_sessionRevoked() public {
        _setupExecuteCall();
        vault.revokeSessionKey(sessionKey1);
        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionRevoked.selector);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
    }

    function test_revert_executeCall_unknownSession() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.SessionNotFound.selector);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
    }

    function test_executeCall_globalSelector() public {
        vault.addAllowedTarget(sessionKey1, address(counter));
        // Add selector globally (target = address(0))
        vault.addAllowedSelector(sessionKey1, address(0), CounterMock.increment.selector);
        vm.prank(sessionKey1);
        vault.executeCall(address(counter), 0, abi.encodeCall(CounterMock.increment, ()));
        assertEq(counter.count(), 1);
    }

    function test_executeCall_valueTracksSpent() public {
        _setupExecuteCall();
        vm.deal(address(vault), 100 ether);
        
        // First call with value
        vm.prank(sessionKey1);
        vault.executeCall(address(counter), 1_000_000, abi.encodeCall(CounterMock.payableIncrement, ()));
        
        // Check spent updated
        AgentPaymentVault.SessionPermission memory perm = vault.getSessionPermission(sessionKey1);
        assertEq(perm.spent, 1_000_000);

        // Payment still works and adds to spent
        vm.prank(sessionKey1);
        vault.executePayment(address(usdc), vendor, 500_000);
        perm = vault.getSessionPermission(sessionKey1);
        assertEq(perm.spent, 1_500_000);
    }

    // ── Target management access control ────────────────────────────

    function test_revert_nonOwnerAddTarget() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.addAllowedTarget(sessionKey1, address(counter));
    }

    function test_revert_nonOwnerAddSelector() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.addAllowedSelector(sessionKey1, address(counter), CounterMock.increment.selector);
    }

    // ── approveAndExecute ───────────────────────────────────────────

    function _setupDEX() internal {
        // Fund DEX with output token (WETH) for swaps
        weth.mint(address(dex), 100_000_000);

        // Add DEX as allowed target for sessionKey1
        vault.addAllowedTarget(sessionKey1, address(dex));
        // Whitelist the swap selectors
        vault.addAllowedSelector(sessionKey1, address(dex), MockDEX.swapWithApprove.selector);
        vault.addAllowedSelector(sessionKey1, address(dex), MockDEX.swapWithTransfer.selector);
    }

    function test_approveAndExecute_LOW() public {
        _setupDEX();
        // Set spender risk to LOW with 2M cap
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 2_000_000);

        vm.prank(sessionKey1);
        vault.approveAndExecute(
            address(usdc),      // token
            address(dex),       // spender
            1_000_000,          // approveAmount (1 USDC)
            address(dex),       // target
            0,                  // value
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),      // outputToken
            1_000_000           // minOutput (1 WETH, 1:1 rate)
        );

        // Vault received output token
        assertEq(weth.balanceOf(address(vault)), 1_000_000);
        // Vault lost input token
        assertEq(usdc.balanceOf(address(vault)), 99_000_000);
    }

    function test_approveAndExecute_MEDIUM() public {
        _setupDEX();
        // Set spender risk to MEDIUM
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.MEDIUM, 2_000_000);

        vm.prank(sessionKey1);
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithTransfer, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            1_000_000
        );

        // Vault received output token
        assertEq(weth.balanceOf(address(vault)), 1_000_000);
        // No approve residual — verify allowance is 0
        assertEq(usdc.allowance(address(vault), address(dex)), 0);
    }

    function test_approveAndExecute_HIGH_trusted() public {
        _setupDEX();
        // Mark DEX as globally trusted
        vault.setTrustedSpender(address(dex), true);
        // Set spender risk to HIGH
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.HIGH, 2_000_000);

        vm.prank(sessionKey1);
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            1_000_000
        );

        assertEq(weth.balanceOf(address(vault)), 1_000_000);
    }

    function test_revert_approveAndExecute_HIGH_untrusted() public {
        _setupDEX();
        // Set spender risk to HIGH but DO NOT mark as trusted
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.HIGH, 2_000_000);

        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.RequiresHumanApproval.selector, address(dex))
        );
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            1_000_000
        );
    }

    function test_ownerApproveAndExecute() public {
        _setupDEX();
        weth.mint(address(dex), 100_000_000); // extra liquidity

        vault.ownerApproveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            1_000_000
        );

        assertEq(weth.balanceOf(address(vault)), 1_000_000);
        // Owner's approveAndExecute revokes approval after
        assertEq(usdc.allowance(address(vault), address(dex)), 0);
    }

    function test_revert_approveAndExecute_insufficientOutput() public {
        _setupDEX();
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 2_000_000);
        vault.addAllowedSelector(sessionKey1, address(dex), MockDEX.swapAndSteal.selector);

        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.InsufficientOutput.selector, 0, 1_000_000)
        );
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapAndSteal, (address(usdc), 1_000_000)),
            address(weth),
            1_000_000  // expecting 1M output, will get 0
        );
    }

    function test_revert_approveAndExecute_exceedsCap() public {
        _setupDEX();
        // Cap is 500_000, try to approve 1_000_000
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 500_000);

        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.ApproveAmountExceedsCap.selector, 1_000_000, 500_000)
        );
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            0
        );
    }

    function test_revert_approveAndExecute_spenderNotConfigured() public {
        _setupDEX();
        // Don't set any risk tier for DEX

        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.SpenderNotConfigured.selector, address(dex))
        );
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            0
        );
    }

    function test_revert_approveAndExecute_targetNotAllowed() public {
        // Set risk tier but DON'T add DEX as allowed target
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 2_000_000);

        vm.prank(sessionKey1);
        vm.expectRevert(
            abi.encodeWithSelector(AgentPaymentVault.TargetNotAllowed.selector, address(dex))
        );
        vault.approveAndExecute(
            address(usdc),
            address(dex),
            1_000_000,
            address(dex),
            0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth),
            0
        );
    }

    function test_revert_setSpenderRisk_nonOwner() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 1_000_000);
    }

    function test_revert_setTrustedSpender_nonOwner() public {
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.setTrustedSpender(address(dex), true);
    }

    function test_revert_ownerApproveAndExecute_nonOwner() public {
        _setupDEX();
        vm.prank(randomAddr);
        vm.expectRevert(AgentPaymentVault.NotOwner.selector);
        vault.ownerApproveAndExecute(
            address(usdc), address(dex), 1_000_000, address(dex), 0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth), 0
        );
    }

    function test_approveAndExecute_sessionExpired() public {
        _setupDEX();
        vault.setSpenderRisk(sessionKey1, address(dex), AgentPaymentVault.RiskTier.LOW, 2_000_000);
        vm.warp(block.timestamp + EXPIRY + 1);

        vm.prank(sessionKey1);
        vm.expectRevert(AgentPaymentVault.SessionExpired.selector);
        vault.approveAndExecute(
            address(usdc), address(dex), 1_000_000, address(dex), 0,
            abi.encodeCall(MockDEX.swapWithApprove, (address(usdc), 1_000_000, address(weth))),
            address(weth), 0
        );
    }
}

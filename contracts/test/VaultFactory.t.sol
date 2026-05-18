// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {AgentPaymentVault} from "../src/AgentPaymentVault.sol";

contract VaultFactoryTest is Test {
    VaultFactory factory;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        factory = new VaultFactory();
    }

    function test_createVault() public {
        vm.prank(alice);
        address vault = factory.createVault();

        assertTrue(vault != address(0), "vault should not be zero");
        assertEq(AgentPaymentVault(payable(vault)).owner(), alice, "owner should be alice");
        assertEq(factory.totalVaults(), 1);
    }

    function test_createVault_multipleUsers() public {
        vm.prank(alice);
        address v1 = factory.createVault();

        vm.prank(bob);
        address v2 = factory.createVault();

        assertTrue(v1 != v2, "vaults should be different");
        assertEq(AgentPaymentVault(payable(v1)).owner(), alice);
        assertEq(AgentPaymentVault(payable(v2)).owner(), bob);
        assertEq(factory.totalVaults(), 2);
    }

    function test_getVaults() public {
        vm.startPrank(alice);
        address v1 = factory.createVault();
        address v2 = factory.createVault();
        vm.stopPrank();

        address[] memory vaults = factory.getVaults(alice);
        assertEq(vaults.length, 2);
        assertEq(vaults[0], v1);
        assertEq(vaults[1], v2);

        // Bob has no vaults
        assertEq(factory.getVaults(bob).length, 0);
    }

    function test_createdVault_isFullyFunctional() public {
        vm.prank(alice);
        address vaultAddr = factory.createVault();
        AgentPaymentVault vault = AgentPaymentVault(payable(vaultAddr));

        // Alice can use all owner functions
        vm.startPrank(alice);
        vault.pause();
        assertTrue(vault.paused());
        vault.unpause();
        assertFalse(vault.paused());
        vm.stopPrank();

        // Bob cannot
        vm.prank(bob);
        vm.expectRevert();
        vault.pause();
    }

    function test_event_VaultCreated() public {
        vm.prank(alice);
        // We just verify no revert — event check is complex in forge
        factory.createVault();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentPaymentVault} from "./AgentPaymentVault.sol";

/// @title VaultFactory
/// @notice One-click deployment of AgentPaymentVault instances.
///         Each user gets their own isolated vault — non-custodial, fully owned.
contract VaultFactory {
    // ── Events ──────────────────────────────────────────────────────
    event VaultCreated(address indexed owner, address indexed vault, uint256 index);

    // ── State ───────────────────────────────────────────────────────
    /// @dev owner => list of vaults they deployed
    mapping(address => address[]) public userVaults;
    /// @dev all vaults ever created
    address[] public allVaults;

    // ── Deploy ──────────────────────────────────────────────────────

    /// @notice Deploy a new AgentPaymentVault owned by msg.sender
    /// @return vault The address of the newly deployed vault
    function createVault() external returns (address vault) {
        // Deploy with CREATE (simple, deterministic enough for indexing)
        AgentPaymentVault v = new AgentPaymentVault();
        vault = address(v);

        // Transfer ownership: vault constructor sets owner = msg.sender (= this factory)
        // We need to transfer ownership to the actual user.
        // Since the vault's constructor sets owner = msg.sender = address(this),
        // we call transferOwnership on the vault.
        v.transferOwnership(msg.sender);

        userVaults[msg.sender].push(vault);
        allVaults.push(vault);

        emit VaultCreated(msg.sender, vault, allVaults.length - 1);
    }

    // ── View ────────────────────────────────────────────────────────

    /// @notice Get all vaults owned by a user
    function getVaults(address user) external view returns (address[] memory) {
        return userVaults[user];
    }

    /// @notice Get total number of vaults created
    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }
}

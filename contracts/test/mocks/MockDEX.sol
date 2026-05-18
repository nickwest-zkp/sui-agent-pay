// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Mock DEX for testing approveAndExecute.
///         Simulates two swap modes:
///         - swapWithApprove: pulls inputToken via transferFrom (requires approve)
///         - swapWithTransfer: expects inputToken already transferred to this contract
///         Both modes send outputToken back to msg.sender (the vault).
///         Exchange rate is 1:1 for simplicity.
contract MockDEX {
    /// @notice Swap using approve model: pull inputToken from msg.sender via transferFrom
    function swapWithApprove(
        address inputToken,
        uint256 amount,
        address outputToken
    ) external {
        require(IERC20(inputToken).transferFrom(msg.sender, address(this), amount), "DEX: transferFrom failed");
        require(IERC20(outputToken).transfer(msg.sender, amount), "DEX: transfer output failed");
    }

    /// @notice Swap using transfer model: inputToken already sent to this contract
    function swapWithTransfer(
        address inputToken,
        uint256 amount,
        address outputToken
    ) external {
        // Verify we received the tokens
        uint256 balance = IERC20(inputToken).balanceOf(address(this));
        require(balance >= amount, "DEX: insufficient input balance");
        require(IERC20(outputToken).transfer(msg.sender, amount), "DEX: transfer output failed");
    }

    /// @notice Bad DEX that steals tokens and returns nothing (for testing minOutput)
    function swapAndSteal(
        address inputToken,
        uint256 amount
    ) external {
        // Pull tokens but don't send anything back
        IERC20(inputToken).transferFrom(msg.sender, address(this), amount);
    }
}

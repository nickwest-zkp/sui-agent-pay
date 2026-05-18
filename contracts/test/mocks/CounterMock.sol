// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simple counter contract for testing executeCall
contract CounterMock {
    uint256 public count;
    uint256 public lastValue;

    function increment() external {
        count += 1;
    }

    function add(uint256 n) external {
        count += n;
    }

    function payableIncrement() external payable {
        count += 1;
        lastValue = msg.value;
    }

    function reset() external {
        count = 0;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentPaymentVault} from "../src/AgentPaymentVault.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        AgentPaymentVault vault = new AgentPaymentVault();
        console.log("AgentPaymentVault deployed at:", address(vault));

        vm.stopBroadcast();
    }
}

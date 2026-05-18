// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address dave = address(0xDA7E);

    function setUp() public {
        registry = new AgentRegistry();
    }

    // ── Identity tests ──────────────────────────────────────────

    function test_register() public {
        vm.prank(alice);
        uint256 id = registry.register("https://agent.example/alice.json");

        assertEq(id, 1);
        assertEq(registry.nextAgentId(), 2);

        (address owner_, string memory uri_, address wallet_, bool active_, uint256 registeredAt_) = registry.getAgent(id);
        assertEq(owner_, alice);
        assertEq(uri_, "https://agent.example/alice.json");
        assertEq(wallet_, alice);
        assertTrue(active_);
        assertTrue(registeredAt_ > 0);

        assertEq(registry.getAgentIdByWallet(alice), id);
    }

    function test_registerWithWallet() public {
        address payWallet = address(0xFA1);
        vm.prank(alice);
        uint256 id = registry.registerWithWallet("https://agent.example/alice.json", payWallet);

        (address owner_,, address wallet_,,) = registry.getAgent(id);
        assertEq(owner_, alice);
        assertEq(wallet_, payWallet);
        assertEq(registry.getAgentIdByWallet(payWallet), id);
    }

    function test_setAgentURI() public {
        vm.prank(alice);
        uint256 id = registry.register("https://old-uri.com");

        vm.prank(alice);
        registry.setAgentURI(id, "https://new-uri.com");

        (, string memory uri_,,,) = registry.getAgent(id);
        assertEq(uri_, "https://new-uri.com");
    }

    function test_setAgentURI_notOwner_reverts() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        vm.expectRevert("NotOwner");
        registry.setAgentURI(id, "https://hack.com");
    }

    function test_deactivate() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(alice);
        registry.deactivate(id);

        (,,, bool active_,) = registry.getAgent(id);
        assertFalse(active_);
    }

    function test_deactivate_notOwner_reverts() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        vm.expectRevert("NotOwner");
        registry.deactivate(id);
    }

    // ── Feedback tests ──────────────────────────────────────────

    function test_giveFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "quality", "good");

        assertEq(registry.feedbackCount(id), 1);

        (address client_, int128 value_, uint8 dec_, string memory t1_, string memory t2_, bool revoked_) =
            registry.readFeedback(id, 1);
        assertEq(client_, bob);
        assertEq(value_, 80);
        assertEq(dec_, 0);
        assertEq(t1_, "quality");
        assertEq(t2_, "good");
        assertFalse(revoked_);
    }

    function test_giveFeedback_cannotRateSelf() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(alice);
        vm.expectRevert("CannotRateSelf");
        registry.giveFeedback(id, 100, 0, "quality", "");
    }

    function test_giveFeedback_inactiveAgent() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(alice);
        registry.deactivate(id);

        vm.prank(bob);
        vm.expectRevert("AgentNotActive");
        registry.giveFeedback(id, 80, 0, "quality", "");
    }

    function test_revokeFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "quality", "");

        // Check summary before revoke
        (uint64 countBefore, int128 totalBefore,) = registry.getSummary(id);
        assertEq(countBefore, 1);
        assertEq(totalBefore, 80);

        vm.prank(bob);
        registry.revokeFeedback(id, 1);

        // Feedback should be marked revoked
        (,,,,, bool revoked_) = registry.readFeedback(id, 1);
        assertTrue(revoked_);

        // Summary should be decremented
        (uint64 countAfter, int128 totalAfter,) = registry.getSummary(id);
        assertEq(countAfter, 0);
        assertEq(totalAfter, 0);
    }

    function test_revokeFeedback_notOwner_reverts() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "quality", "");

        vm.prank(carol);
        vm.expectRevert("NotFeedbackOwner");
        registry.revokeFeedback(id, 1);
    }

    function test_revokeFeedback_alreadyRevoked_reverts() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "quality", "");

        vm.prank(bob);
        registry.revokeFeedback(id, 1);

        vm.prank(bob);
        vm.expectRevert("AlreadyRevoked");
        registry.revokeFeedback(id, 1);
    }

    // ── Average score tests ─────────────────────────────────────

    function test_getAverageScore_belowMinFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        // Only 2 feedbacks, below MIN_FEEDBACK_FOR_RATING (3)
        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 90, 0, "", "");

        int128 avg = registry.getAverageScore(id);
        assertEq(avg, -1); // insufficient feedback
    }

    function test_getAverageScore_withEnoughFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 90, 0, "", "");
        vm.prank(dave);
        registry.giveFeedback(id, 70, 0, "", "");

        int128 avg = registry.getAverageScore(id);
        assertEq(avg, 80); // (80+90+70)/3 = 80
    }

    // ── Risk assessment tests ───────────────────────────────────

    function test_assessRisk_UNKNOWN() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        // No feedbacks
        (AgentRegistry.RiskLevel risk, int128 score) = registry.assessRisk(id);
        assertTrue(risk == AgentRegistry.RiskLevel.UNKNOWN);
        assertEq(score, -1);
    }

    function test_assessRisk_LOW() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 90, 0, "", "");
        vm.prank(dave);
        registry.giveFeedback(id, 70, 0, "", "");

        (AgentRegistry.RiskLevel risk, int128 score) = registry.assessRisk(id);
        assertTrue(risk == AgentRegistry.RiskLevel.LOW);
        assertEq(score, 80);
    }

    function test_assessRisk_MEDIUM() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 50, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 60, 0, "", "");
        vm.prank(dave);
        registry.giveFeedback(id, 40, 0, "", "");

        (AgentRegistry.RiskLevel risk, int128 score) = registry.assessRisk(id);
        assertTrue(risk == AgentRegistry.RiskLevel.MEDIUM);
        assertEq(score, 50); // (50+60+40)/3 = 50
    }

    function test_assessRisk_HIGH() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 10, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 20, 0, "", "");
        vm.prank(dave);
        registry.giveFeedback(id, 30, 0, "", "");

        (AgentRegistry.RiskLevel risk, int128 score) = registry.assessRisk(id);
        assertTrue(risk == AgentRegistry.RiskLevel.HIGH);
        assertEq(score, 20); // (10+20+30)/3 = 20
    }

    // ── isReputable tests ───────────────────────────────────────

    function test_isReputable_unregistered() public view {
        (bool registered, AgentRegistry.RiskLevel risk, int128 score) = registry.isReputable(address(0xDEAD));
        assertFalse(registered);
        assertTrue(risk == AgentRegistry.RiskLevel.UNKNOWN);
        assertEq(score, -1);
    }

    function test_isReputable_registered_noFeedback() public {
        vm.prank(alice);
        registry.register("https://uri.com");

        (bool registered, AgentRegistry.RiskLevel risk, int128 score) = registry.isReputable(alice);
        assertTrue(registered);
        assertTrue(risk == AgentRegistry.RiskLevel.UNKNOWN);
        assertEq(score, -1);
    }

    function test_isReputable_registered_withFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 80, 0, "", "");
        vm.prank(carol);
        registry.giveFeedback(id, 90, 0, "", "");
        vm.prank(dave);
        registry.giveFeedback(id, 70, 0, "", "");

        (bool registered, AgentRegistry.RiskLevel risk, int128 score) = registry.isReputable(alice);
        assertTrue(registered);
        assertTrue(risk == AgentRegistry.RiskLevel.LOW);
        assertEq(score, 80);
    }

    // ── Event tests ─────────────────────────────────────────────

    function test_event_Registered() public {
        vm.prank(alice);
        vm.expectEmit(true, false, true, true);
        emit AgentRegistry.Registered(1, "https://uri.com", alice);
        registry.register("https://uri.com");
    }

    function test_event_NewFeedback() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit AgentRegistry.NewFeedback(id, bob, 1, 85, 0, "speed", "fast");
        registry.giveFeedback(id, 85, 0, "speed", "fast");
    }

    function test_event_FeedbackRevoked() public {
        vm.prank(alice);
        uint256 id = registry.register("https://uri.com");

        vm.prank(bob);
        registry.giveFeedback(id, 85, 0, "", "");

        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit AgentRegistry.FeedbackRevoked(id, bob, 1);
        registry.revokeFeedback(id, 1);
    }
}

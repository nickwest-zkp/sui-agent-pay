import type {
  HardPolicyResult,
  AiRiskResult,
  AggregatedDecision,
  Decision,
} from "../types";

/**
 * Decision Aggregator — combines hard-rule and AI risk results
 * into a single final decision.
 *
 * Decision matrix:
 *   hard=deny,  AI=any      → deny
 *   hard=allow, AI=low      → allow
 *   hard=allow, AI=medium   → require_approval
 *   hard=allow, AI=high     → deny
 *   hard=approval, AI=low   → require_approval
 *   hard=approval, AI=med+  → deny
 *
 * AI can only shrink permissions, never expand them.
 */
export class DecisionAggregator {
  aggregate(
    hardResult: HardPolicyResult,
    aiResult: AiRiskResult
  ): AggregatedDecision {
    let decision: Decision;

    if (!hardResult.passed) {
      // Hard rules rejected — final answer, AI irrelevant
      decision = "deny";
    } else if (hardResult.requiresApproval) {
      // Hard rules say requires approval
      if (aiResult.level === "low") {
        decision = "require_approval";
      } else {
        // Medium or high AI risk on top of approval requirement → deny
        decision = "deny";
      }
    } else {
      // Hard rules passed
      switch (aiResult.level) {
        case "low":
          decision = "allow";
          break;
        case "medium":
          decision = "require_approval";
          break;
        case "high":
          decision = "deny";
          break;
        default:
          decision = "require_approval";
      }
    }

    return {
      decision,
      hardPolicy: hardResult,
      aiRisk: aiResult,
    };
  }

  /**
   * Fallback decision when AI is unavailable.
   * High-value ops → deny; low-value repetitive ops → use hard rules only.
   */
  aggregateWithoutAi(
    hardResult: HardPolicyResult,
    approvalThreshold: bigint,
    amount: bigint
  ): AggregatedDecision {
    const fallbackAi: AiRiskResult = {
      score: -1,
      level: "medium",
      reasons: ["ai_unavailable"],
      modelVersion: "fallback",
    };

    let decision: Decision;

    if (!hardResult.passed) {
      decision = "deny";
    } else if (hardResult.requiresApproval) {
      decision = "deny"; // Conservative when AI is down
    } else if (amount > approvalThreshold) {
      decision = "deny"; // High value without AI → deny
    } else {
      decision = "allow"; // Low value, hard rules pass → allow with warning
      fallbackAi.reasons.push("ai_bypass_low_value");
    }

    return { decision, hardPolicy: hardResult, aiRisk: fallbackAi };
  }
}

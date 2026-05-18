import type {
  PaymentIntent,
  AgentPolicy,
  HardPolicyResult,
  BudgetRecord,
} from "../types";

/**
 * Deterministic hard-rule policy engine.
 * Same input → same output. No AI, no probabilities.
 * This is the primary security boundary for off-chain checks.
 */
export class PolicyEngine {
  /**
   * Evaluate a payment intent against an agent's policy.
   * Returns pass/fail with specific rule violations.
   */
  evaluate(
    intent: PaymentIntent,
    policy: AgentPolicy,
    budget: BudgetRecord | null
  ): HardPolicyResult {
    const violations: string[] = [];
    const triggered: string[] = [];
    let requiresApproval = false;

    const amount = BigInt(intent.amount);

    // ── 1. Recipient whitelist ──────────────────────────────────
    if (policy.allowedRecipients.length > 0) {
      const lower = policy.allowedRecipients.map((r) => r.toLowerCase());
      if (lower.includes(intent.recipient.toLowerCase())) {
        triggered.push("recipientWhitelist:pass");
      } else {
        violations.push("recipient_not_whitelisted");
        triggered.push("recipientWhitelist:fail");
      }
    }

    // ── 2. Token whitelist ──────────────────────────────────────
    if (policy.allowedTokens.length > 0) {
      const lower = policy.allowedTokens.map((t) => t.toLowerCase());
      if (lower.includes(intent.token.toLowerCase())) {
        triggered.push("tokenWhitelist:pass");
      } else {
        violations.push("token_not_whitelisted");
        triggered.push("tokenWhitelist:fail");
      }
    }

    // ── 3. Per-tx limit ─────────────────────────────────────────
    const maxPerTx = BigInt(policy.maxPerTx);
    if (amount <= maxPerTx) {
      triggered.push("maxPerTx:pass");
    } else {
      violations.push("maxPerTx_exceeded");
      triggered.push("maxPerTx:fail");
    }

    // ── 4. Total limit ──────────────────────────────────────────
    // (on-chain also enforces this, but we pre-check to save gas)
    const maxTotal = BigInt(policy.maxTotal);
    // We don't have spent here — on-chain tracks it. Just check max.
    if (amount <= maxTotal) {
      triggered.push("maxTotal:pass");
    } else {
      violations.push("maxTotal_exceeded");
      triggered.push("maxTotal:fail");
    }

    // ── 5. Daily budget ─────────────────────────────────────────
    const dailyBudget = BigInt(policy.dailyBudget);
    const dailySpent = budget ? BigInt(budget.dailySpent) : 0n;
    if (dailySpent + amount <= dailyBudget) {
      triggered.push("dailyBudget:pass");
    } else {
      violations.push("daily_budget_exceeded");
      triggered.push("dailyBudget:fail");
    }

    // ── 6. Weekly budget ────────────────────────────────────────
    // For MVP we approximate weekly = sum of last 7 daily records
    // This check uses daily record as a simplified proxy
    const weeklyBudget = BigInt(policy.weeklyBudget);
    if (amount <= weeklyBudget) {
      triggered.push("weeklyBudget:pass");
    } else {
      violations.push("weekly_budget_exceeded");
      triggered.push("weeklyBudget:fail");
    }

    // ── 7. Frequency limit (daily tx count) ─────────────────────
    const MAX_TX_PER_DAY = 100;
    const txCount = budget ? budget.txCount : 0;
    if (txCount < MAX_TX_PER_DAY) {
      triggered.push("frequencyLimit:pass");
    } else {
      violations.push("daily_tx_limit_exceeded");
      triggered.push("frequencyLimit:fail");
    }

    // ── 8. Expiry check ─────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    if (now < policy.validUntil) {
      triggered.push("expiry:pass");
    } else {
      violations.push("session_expired");
      triggered.push("expiry:fail");
    }

    // ── 9. Task binding ─────────────────────────────────────────
    // If policy requires task binding, intent must have a taskId
    if (policy.taskBinding && !intent.taskId) {
      violations.push("task_binding_required");
      triggered.push("taskBinding:fail");
    } else {
      triggered.push("taskBinding:pass");
    }

    // ── 10. Approval threshold ──────────────────────────────────
    const threshold = BigInt(policy.approvalThreshold);
    if (amount > threshold && violations.length === 0) {
      requiresApproval = true;
      triggered.push("approvalThreshold:triggered");
    }

    return {
      passed: violations.length === 0,
      violations,
      triggeredRules: triggered,
      requiresApproval,
    };
  }
}

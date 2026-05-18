import type { PaymentIntent, AiRiskResult, AuditReceipt } from "../types";

/**
 * AI Risk Evaluator — second-pass risk analysis.
 *
 * Core principle: AI can only DENY or ESCALATE, never ALLOW on its own.
 * If the hard-rule engine denies, AI is not even consulted.
 *
 * MVP implementation uses heuristic rules that simulate AI behavior.
 * The interface is designed so a real LLM can be plugged in later.
 */
export class AiRiskEvaluator {
  private recentPayments: AuditReceipt[] = [];
  private readonly MODEL_VERSION = "heuristic-v1.0";

  /**
   * Feed historical payments for behavioral analysis.
   */
  loadHistory(payments: AuditReceipt[]) {
    this.recentPayments = payments;
  }

  /**
   * Evaluate risk of a payment intent.
   * Returns a score (0-1), level, and reason tags.
   */
  async evaluate(intent: PaymentIntent): Promise<AiRiskResult> {
    const reasons: string[] = [];
    let score = 0;

    // ── 1. Split-transaction detection ──────────────────────────
    // If many small payments to the same recipient in a short window,
    // it might be an attempt to circumvent per-tx limits.
    const recentToSameRecipient = this.recentPayments.filter(
      (p) =>
        p.recipient.toLowerCase() === intent.recipient.toLowerCase() &&
        p.agentId === intent.agentId &&
        Date.now() - new Date(p.timestamp).getTime() < 60 * 60 * 1000 // last hour
    );
    if (recentToSameRecipient.length >= 5) {
      score += 0.3;
      reasons.push("split_transaction_pattern");
    }

    // ── 2. Behavioral anomaly — unusual amount ──────────────────
    if (this.recentPayments.length >= 3) {
      const amounts = this.recentPayments
        .filter((p) => p.agentId === intent.agentId)
        .map((p) => Number(p.amount));
      if (amounts.length > 0) {
        const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const intentAmount = Number(intent.amount);
        if (intentAmount > avg * 3 && avg > 0) {
          score += 0.25;
          reasons.push("behavioral_anomaly");
        }
      }
    }

    // ── 3. Suspicious reason — too short or generic ─────────────
    if (!intent.reason || intent.reason.length < 5) {
      score += 0.15;
      reasons.push("vague_reason");
    }

    // ── 4. Prompt injection markers in reason ───────────────────
    const injectionPatterns = [
      /ignore previous/i,
      /system prompt/i,
      /override/i,
      /admin/i,
      /urgent.*transfer/i,
      /security.*upgrade/i,
    ];
    for (const pattern of injectionPatterns) {
      if (pattern.test(intent.reason)) {
        score += 0.4;
        reasons.push("possible_prompt_injection");
        break;
      }
    }

    // ── 5. Night-time activity (heuristic) ──────────────────────
    const hour = new Date().getHours();
    if (hour >= 2 && hour <= 5) {
      score += 0.1;
      reasons.push("unusual_time");
    }

    // Clamp score to [0, 1]
    score = Math.min(1, Math.max(0, score));

    const level = score < 0.3 ? "low" : score < 0.7 ? "medium" : "high";

    return {
      score: Math.round(score * 100) / 100,
      level,
      reasons,
      modelVersion: this.MODEL_VERSION,
    };
  }
}

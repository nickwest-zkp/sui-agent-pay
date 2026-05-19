import type {
  AuditReceipt,
  PaymentIntent,
  AggregatedDecision,
} from "../types";
import { randomUUID } from "crypto";

/**
 * Structured audit logger.
 * Every payment attempt produces an AuditReceipt regardless of outcome.
 * Receipts are stored in SQLite for queryability.
 */
export class AuditLogger {
  /**
   * Build a full audit receipt from intent + decision context.
   */
  createReceipt(
    intent: PaymentIntent,
    decision: AggregatedDecision,
    extra: {
      userId: string;
      agentType: string;
      humanApproved: boolean;
      signerType: string;
      txHash?: string;
      result: string;
      gasUsed?: string;
    }
  ): AuditReceipt {
    return {
      paymentId: randomUUID(),
      taskId: intent.taskId,
      operation: intent.operation ?? "payment",
      agentId: intent.agentId,
      agentType: extra.agentType as "long_lived" | "temporary",
      userId: extra.userId,
      reason: intent.reason,
      recipient: intent.recipient,
      token: intent.token,
      amount: intent.amount,
      category: intent.category,
      contractCall: intent.contractCall,
      deepbookSwap: intent.deepbookSwap,
      hardPolicy: decision.hardPolicy,
      aiRisk: decision.aiRisk,
      finalDecision: decision.decision,
      humanApproved: extra.humanApproved,
      signerType: extra.signerType,
      txHash: extra.txHash,
      result: extra.result,
      gasUsed: extra.gasUsed,
      timestamp: new Date().toISOString(),
    };
  }
}

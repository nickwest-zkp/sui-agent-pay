/**
 * Inter-Agent Settlement — orchestrates Agent-to-Agent paid service calls
 *
 * High-level flow:
 * 1. Agent A calls Agent B's paid HTTP endpoint
 * 2. Receives 402 → parses payment requirements
 * 3. Runs through local policy engine
 * 4. If approved → pays via vault → retries with receipt
 * 5. Records settlement audit on both sides
 *
 * This module is a thin orchestration layer; actual HTTP / payment logic
 * lives in x402-client.ts, and policy logic lives in the SDK core.
 */

import type {
  X402HttpRequestOptions,
  X402HttpResult,
  InterAgentSettlementResult,
  PaymentResult,
  ReputationAssessment,
} from "../types";
import {
  makeHttpRequest,
  parsePaymentRequired,
  toPaymentIntent,
  retryWithReceipt,
} from "../x402/x402-client";

export interface SettlementDeps {
  /** Run the payment intent through policy + execute on-chain */
  requestPayment: (
    intent: { taskId: string; agentId: string; reason: string; recipient: string; token: string; amount: string; category?: string },
    sessionKey: string
  ) => Promise<PaymentResult>;
  /** Optional: check counterparty reputation before paying */
  checkReputationByWallet?: (wallet: string) => Promise<ReputationAssessment>;
}

/**
 * Call a paid Agent service, handling 402 automatically.
 *
 * - If the endpoint returns 200 directly, no payment is made.
 * - If 402, attempts to pay via vault and retries.
 * - Any other HTTP status is returned as-is.
 */
export async function callPaidService(
  opts: X402HttpRequestOptions,
  sessionKey: string,
  deps: SettlementDeps
): Promise<InterAgentSettlementResult> {
  // Step 1: Initial HTTP request
  const initial = await makeHttpRequest(opts);

  // Not a 402 — return directly (free endpoint or error)
  if (initial.status !== 402) {
    return {
      httpResult: {
        httpStatus: initial.status,
        responseBody: initial.body,
        responseHeaders: initial.headers,
        paid: false,
      },
      settlementType: "direct",
      counterpartyService: opts.url,
    };
  }

  // Step 2: Parse 402 payment requirements
  const paymentHeader =
    initial.headers["payment-required"] ??
    initial.headers["x-payment-required"];

  if (!paymentHeader) {
    return {
      httpResult: {
        httpStatus: 402,
        responseBody: initial.body,
        responseHeaders: initial.headers,
        paid: false,
      },
      settlementType: "x402",
      counterpartyService: opts.url,
    };
  }

  const requirements = parsePaymentRequired(paymentHeader);
  const intent = toPaymentIntent(requirements, opts);

  // Step 2.5: Check counterparty reputation (if available)
  let reputationWarning: string | undefined;
  let counterpartyReputation: ReputationAssessment | undefined;
  if (deps.checkReputationByWallet) {
    try {
      counterpartyReputation = await deps.checkReputationByWallet(requirements.payTo);
      if (counterpartyReputation.riskLevel === "HIGH") {
        reputationWarning = `HIGH_RISK: counterparty score ${counterpartyReputation.avgScore}/100`;
      } else if (counterpartyReputation.riskLevel === "UNKNOWN") {
        reputationWarning = counterpartyReputation.registered
          ? "UNRATED: counterparty has insufficient feedback"
          : "UNREGISTERED: counterparty not found in agent registry";
      }
    } catch {
      // reputation check failed — proceed without
    }
  }

  // Step 3: Run through policy engine + execute payment
  const paymentResult = await deps.requestPayment(intent, sessionKey);

  if (paymentResult.result !== "success" || !paymentResult.txHash) {
    return {
      httpResult: {
        httpStatus: 402,
        responseBody: JSON.stringify({
          error: "Payment not approved",
          decision: paymentResult.decision,
          result: paymentResult.result,
        }),
        responseHeaders: initial.headers,
        paymentResult,
        paid: false,
      },
      settlementType: "x402",
      counterpartyService: opts.url,
      paymentId: paymentResult.paymentId,
      reputationWarning,
      counterpartyReputation,
    };
  }

  // Step 4: Retry original request with payment receipt
  const retry = await retryWithReceipt(opts, paymentResult.txHash);

  return {
    httpResult: {
      httpStatus: retry.status,
      responseBody: retry.body,
      responseHeaders: retry.headers,
      paymentResult,
      paid: true,
    },
    settlementType: "x402",
    counterpartyService: opts.url,
    paymentId: paymentResult.paymentId,
    txHash: paymentResult.txHash,
    reputationWarning,
    counterpartyReputation,
  };
}

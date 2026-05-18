/**
 * x402 Client — handles HTTP 402 Payment Required flow
 *
 * When an Agent makes an HTTP request and receives 402:
 * 1. Parse PAYMENT-REQUIRED header → X402PaymentRequirements
 * 2. Convert to PaymentIntent → run through policy engine
 * 3. If approved → executePayment via vault → get txHash
 * 4. Retry original request with PAYMENT-RECEIPT header (txHash proof)
 *
 * MVP: Uses vault's executePayment (direct transfer) instead of
 * EIP-3009/Permit2 signatures — fully compatible with x402 servers
 * that verify on-chain transfers.
 */

import type {
  X402PaymentRequirements,
  X402HttpRequestOptions,
  X402HttpResult,
  PaymentIntent,
} from "../types";
import { assertCoinType, assertSafeHttpUrl, assertSuiAddress, getHttpTimeoutMs, normalizeHttpMethod, parsePositiveU64 } from "../validation";

// ── Header parsing ──────────────────────────────────────────────

/**
 * Parse the PAYMENT-REQUIRED header (base64-encoded JSON) from a 402 response.
 */
export function parsePaymentRequired(headerValue: string): X402PaymentRequirements {
  try {
    // x402 v2: header is base64-encoded JSON
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);

    // Support both single requirement and array format
    const req = Array.isArray(parsed) ? parsed[0] : parsed;

    if (!req.scheme || !req.network || !req.amount || !req.asset || !req.payTo) {
      throw new Error("Missing required fields in PaymentRequirements");
    }

    return {
      scheme: req.scheme,
      network: req.network,
      amount: String(req.amount),
      asset: req.asset,
      payTo: req.payTo,
      description: req.description,
      resource: req.resource,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
    };
  } catch (err: any) {
    // Fallback: try plain JSON (non-base64)
    try {
      const parsed = JSON.parse(headerValue);
      const req = Array.isArray(parsed) ? parsed[0] : parsed;
      return {
        scheme: req.scheme,
        network: req.network,
        amount: String(req.amount),
        asset: req.asset,
        payTo: req.payTo,
        description: req.description,
        resource: req.resource,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
      };
    } catch {
      throw new Error(`Failed to parse PAYMENT-REQUIRED header: ${err.message}`);
    }
  }
}

// ── PaymentIntent conversion ────────────────────────────────────

/**
 * Convert x402 PaymentRequirements into a PaymentIntent for the policy engine.
 */
export function toPaymentIntent(
  requirements: X402PaymentRequirements,
  opts: X402HttpRequestOptions
): PaymentIntent {
  assertSuiAddress(requirements.payTo, "payment requirements payTo");
  assertCoinType(requirements.asset, "payment requirements asset");
  parsePositiveU64(requirements.amount, "payment requirements amount");

  return {
    taskId: opts.taskId,
    agentId: opts.agentId,
    reason: `x402: ${opts.reason} — ${requirements.description ?? opts.url}`,
    recipient: requirements.payTo,
    token: requirements.asset,
    amount: requirements.amount,
    category: "x402_http_payment",
  };
}

// ── HTTP helpers ────────────────────────────────────────────────

/**
 * Make the initial HTTP request. Returns response with status and headers.
 */
export async function makeHttpRequest(
  opts: X402HttpRequestOptions
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  assertSafeHttpUrl(opts.url);
  const method = normalizeHttpMethod(opts.method);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHttpTimeoutMs());

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    headers[key.toLowerCase()] = val;
  });

  const body = await res.text();
  return { status: res.status, headers, body };
}

/**
 * Retry the original request with the payment receipt attached.
 * Sends txHash as proof of on-chain payment in the X-PAYMENT-RECEIPT header.
 */
export async function retryWithReceipt(
  opts: X402HttpRequestOptions,
  txHash: string,
  network = "sui"
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  assertSafeHttpUrl(opts.url);
  const method = normalizeHttpMethod(opts.method);
  const receiptPayload = JSON.stringify({ txHash, network });
  const encoded = Buffer.from(receiptPayload).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getHttpTimeoutMs());

  const mergedHeaders: Record<string, string> = {
    ...opts.headers,
    // Standard x402 header for payment proof
    "x-payment-receipt": encoded,
    // Also include raw txHash for simpler server implementations
    "x-payment-txhash": txHash,
  };

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method,
      headers: mergedHeaders,
      body: opts.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    headers[key.toLowerCase()] = val;
  });

  const body = await res.text();
  return { status: res.status, headers, body };
}

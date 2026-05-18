import type { PaidService, X402PaymentRequirements } from "../types";
import { SUI_NETWORKS } from "../sui-types";
import { assertCoinType, assertSuiAddress, parsePositiveU64 } from "../validation";

function unwrapTransaction(raw: unknown): any {
  if (!raw || typeof raw !== "object") return null;
  if ("$kind" in raw && raw.$kind === "Transaction" && "Transaction" in raw) {
    return (raw as any).Transaction;
  }
  if ("$kind" in raw && raw.$kind === "FailedTransaction" && "FailedTransaction" in raw) {
    return (raw as any).FailedTransaction;
  }
  return raw;
}

export function createPaymentRequiredHeader(service: PaidService): string {
  assertSuiAddress(service.payToAddress, "payToAddress");
  assertCoinType(service.priceToken, "priceToken");
  parsePositiveU64(service.priceAmount, "priceAmount");

  const requirements: X402PaymentRequirements = {
    scheme: service.scheme,
    network: service.network,
    amount: service.priceAmount,
    asset: service.priceToken,
    payTo: service.payToAddress,
    description: service.description,
    resource: service.url,
  };

  return Buffer.from(JSON.stringify(requirements)).toString("base64");
}

export function build402Response(service: PaidService): {
  status: 402;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status: 402,
    headers: {
      "payment-required": createPaymentRequiredHeader(service),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      error: "Payment Required",
      description: service.description,
      price: service.priceAmount,
      token: service.priceToken,
      payTo: service.payToAddress,
      network: service.network,
    }),
  };
}

export async function verifyPaymentOnChain(
  fullnodeUrl: string,
  txHash: string,
  expectedPayTo: string,
  expectedToken: string,
  expectedAmount: string
): Promise<{ verified: boolean; reason?: string }> {
  try {
    assertSuiAddress(expectedPayTo, "expectedPayTo");
    assertCoinType(expectedToken, "expectedToken");
    const { SuiGrpcClient } = await import("@mysten/sui/grpc");

    const matchingNetwork = Object.values(SUI_NETWORKS).find(
      ({ grpcUrl }) => grpcUrl === fullnodeUrl
    );

    const client = new SuiGrpcClient({
      network: matchingNetwork?.sdkNetwork ?? "testnet",
      baseUrl: fullnodeUrl,
    });

    const raw = await client.getTransaction({
      digest: txHash,
      include: {
        balanceChanges: true,
        effects: true,
        events: true,
      },
    });

    const tx = unwrapTransaction(raw);
    if (!tx) {
      return { verified: false, reason: "Transaction not found" };
    }

    if (tx.status && tx.status.$kind && tx.status.$kind !== "Success") {
      return { verified: false, reason: "Transaction execution failed" };
    }

    const expectedAmountBigInt = BigInt(expectedAmount);
    const balanceChanges = Array.isArray(tx.balanceChanges) ? tx.balanceChanges : [];

    const matchedChange = balanceChanges.find((change: any) => {
      if (!change || typeof change !== "object") return false;
      return (
        typeof change.address === "string" &&
        change.address.toLowerCase() === expectedPayTo.toLowerCase() &&
        typeof change.coinType === "string" &&
        change.coinType === expectedToken &&
        BigInt(change.amount) >= expectedAmountBigInt
      );
    });

    if (matchedChange) {
      return { verified: true };
    }

    return { verified: false, reason: "No matching Sui balance change found" };
  } catch (err: any) {
    return { verified: false, reason: `Verification error: ${err.message}` };
  }
}

export function parsePaymentReceipt(
  headerValue: string
): { txHash: string; network?: string } | null {
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (parsed.txHash) return { txHash: parsed.txHash, network: parsed.network };
  } catch {
    if (typeof headerValue === "string" && headerValue.length > 20) {
      return { txHash: headerValue };
    }
  }
  return null;
}

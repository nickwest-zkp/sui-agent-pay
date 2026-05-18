import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type PaymentRuntimeSdk = {
  getSystemStatus(): { coinType: string };
  requestPayment(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    recipient: string;
    token: string;
    amount: string;
  }, sessionKeyPrivate: string): Promise<unknown>;
  requestPaymentForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    recipient: string;
    token: string;
    amount: string;
  }): Promise<unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      taskId?: string;
      agentId?: string;
      reason?: string;
      recipient?: string;
      token?: string;
      amount?: string;
      sessionKey?: string;
    };

    if (!body.agentId || !body.reason || !body.recipient || !body.amount) {
      return fail("agentId, reason, recipient and amount are required");
    }

    const agentId = body.agentId;
    const reason = body.reason;
    const recipient = body.recipient;
    const amount = body.amount;
    const token = body.token;
    const sessionKey = body.sessionKey;
    const taskId = body.taskId ?? randomUUID();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as PaymentRuntimeSdk;
      return sessionKey
        ? runtimeSdk.requestPayment(
            {
              taskId,
              agentId,
              reason,
              recipient,
              token: token ?? runtimeSdk.getSystemStatus().coinType,
              amount,
            },
            sessionKey,
          )
        : runtimeSdk.requestPaymentForAgent({
            taskId,
            agentId,
            reason,
            recipient,
            token: token ?? runtimeSdk.getSystemStatus().coinType,
            amount,
          })
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to execute SDK payment", 500, error instanceof Error ? error.message : String(error));
  }
}

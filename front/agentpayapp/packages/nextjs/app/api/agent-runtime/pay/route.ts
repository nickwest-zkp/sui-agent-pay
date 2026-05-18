import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type AgentRuntimeSdk = {
  getSystemStatus(): { coinType: string };
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
    };

    if (!body.agentId || !body.reason || !body.recipient || !body.amount) {
      return fail("agentId, reason, recipient and amount are required");
    }

    const agentId = body.agentId;
    const reason = body.reason;
    const recipient = body.recipient;
    const amount = body.amount;
    const token = body.token;
    const taskId = body.taskId ?? randomUUID();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as AgentRuntimeSdk;
      return runtimeSdk.requestPaymentForAgent({
        taskId,
        agentId,
        reason,
        recipient,
        token: token ?? runtimeSdk.getSystemStatus().coinType,
        amount,
      });
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to execute runtime agent payment", 500, error instanceof Error ? error.message : String(error));
  }
}

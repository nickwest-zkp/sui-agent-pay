import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type AgentRuntimeSdk = {
  requestHttpPaymentForAgent(opts: {
    url: string;
    method?: string;
    body?: string;
    agentId: string;
    taskId: string;
    reason: string;
  }): Promise<unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      url?: string;
      method?: string;
      body?: string;
      agentId?: string;
      taskId?: string;
      reason?: string;
    };

    if (!body.url || !body.agentId || !body.reason) {
      return fail("url, agentId and reason are required");
    }

    const url = body.url;
    const agentId = body.agentId;
    const reason = body.reason;
    const method = body.method;
    const requestBody = body.body;
    const taskId = body.taskId ?? randomUUID();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as AgentRuntimeSdk;
      return runtimeSdk.requestHttpPaymentForAgent({
        url,
        method,
        body: requestBody,
        agentId,
        taskId,
        reason,
      });
    });

    return ok(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isUserError =
      message.includes("Agent not found") ||
      message.includes("session private key is not stored locally") ||
      message.includes("session key is revoked") ||
      message.includes("session key is expired") ||
      message.includes("does not match the selected agent session key");
    return fail(
      "Failed to execute runtime x402 request",
      isUserError ? 400 : 500,
      message,
    );
  }
}

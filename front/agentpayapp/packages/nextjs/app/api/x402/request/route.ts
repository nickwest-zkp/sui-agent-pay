import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type X402RuntimeSdk = {
  requestHttpPayment(opts: {
    url: string;
    method?: string;
    body?: string;
    agentId: string;
    taskId: string;
    reason: string;
  }, sessionKeyPrivate: string): Promise<unknown>;
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
      sessionKey?: string;
    };

    if (!body.url || !body.agentId || !body.reason) {
      return fail("url, agentId and reason are required");
    }

    const url = body.url;
    const agentId = body.agentId;
    const reason = body.reason;
    const method = body.method;
    const requestBody = body.body;
    const sessionKey = body.sessionKey;
    const taskId = body.taskId ?? randomUUID();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as X402RuntimeSdk;
      return sessionKey
        ? runtimeSdk.requestHttpPayment(
            {
              url,
              method,
              body: requestBody,
              agentId,
              taskId,
              reason,
            },
            sessionKey,
          )
        : runtimeSdk.requestHttpPaymentForAgent({
            url,
            method,
            body: requestBody,
            agentId,
            taskId,
            reason,
          })
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to run x402 request", 500, error instanceof Error ? error.message : String(error));
  }
}

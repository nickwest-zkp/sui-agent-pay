import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type AgentRuntimeSdk = {
  requestContractCallForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    contractCall: {
      packageId: string;
      module: string;
      functionName: string;
      typeArguments: string[];
      arguments: Array<{
        kind: "object" | "address" | "u64" | "string" | "bool";
        value: string | boolean;
      }>;
      walletAddress?: string;
    };
  }): Promise<unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      taskId?: string;
      agentId?: string;
      reason?: string;
      walletAddress?: string;
      packageId?: string;
      module?: string;
      functionName?: string;
      typeArguments?: string[];
      arguments?: Array<{
        kind: "object" | "address" | "u64" | "string" | "bool";
        value: string | boolean;
      }>;
    };

    if (!body.agentId || !body.reason || !body.packageId || !body.module || !body.functionName) {
      return fail("agentId, reason, packageId, module, and functionName are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as AgentRuntimeSdk;
      return runtimeSdk.requestContractCallForAgent({
        taskId: body.taskId ?? randomUUID(),
        agentId: body.agentId!,
        reason: body.reason!,
        contractCall: {
          packageId: body.packageId!,
          module: body.module!,
          functionName: body.functionName!,
          typeArguments: Array.isArray(body.typeArguments) ? body.typeArguments : [],
          arguments: Array.isArray(body.arguments) ? body.arguments : [],
          walletAddress: body.walletAddress,
        },
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
    return fail("Failed to execute runtime contract call", isUserError ? 400 : 500, message);
  }
}

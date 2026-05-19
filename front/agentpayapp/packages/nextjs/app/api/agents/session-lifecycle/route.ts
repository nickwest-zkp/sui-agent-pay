import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type RuntimeSdk = {
  listSessionAssets(
    agentId: string,
    options?: { keepSuiGas?: string }
  ): Promise<{
    agentId: string;
    label: string;
    sessionKey: string;
    expiresAt: number;
    expired: boolean;
    revoked: boolean;
    assets: Array<{
      coinType: string;
      balance: string;
      recoverableBalance: string;
    }>;
  }>;
  recoverSessionAssets(
    agentId: string,
    recipient: string,
    options?: { keepSuiGas?: string; coinTypes?: string[] }
  ): Promise<unknown>;
  markLocalAgentRevoked(agentId: string, revokedAt?: string): {
    agentId: string;
    label: string;
    agentType: "long_lived" | "temporary";
    userId: string;
    sessionKey: string;
    vaultId: string;
    coinType: string;
    createdAt: string;
    revokedAt?: string;
    sessionKeyPrivate?: string;
  };
};

function sanitizeAgent(agent: {
  agentId: string;
  label: string;
  agentType: "long_lived" | "temporary";
  userId: string;
  sessionKey: string;
  vaultId: string;
  coinType: string;
  createdAt: string;
  revokedAt?: string;
  sessionKeyPrivate?: string;
}) {
  return {
    agentId: agent.agentId,
    label: agent.label,
    agentType: agent.agentType,
    userId: agent.userId,
    sessionKey: agent.sessionKey,
    vaultId: agent.vaultId,
    coinType: agent.coinType,
    createdAt: agent.createdAt,
    revokedAt: agent.revokedAt,
    hasStoredSessionKey: Boolean(agent.sessionKeyPrivate),
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    const keepSuiGas = searchParams.get("keepSuiGas") ?? undefined;

    if (!agentId) {
      return fail("agentId is required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.listSessionAssets(agentId, { keepSuiGas });
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to inspect session lifecycle", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "recover" | "mark_revoked";
      agentId?: string;
      recipient?: string;
      keepSuiGas?: string;
      coinTypes?: string[];
      revokedAt?: string;
    };

    if (!body.action || !body.agentId) {
      return fail("action and agentId are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;

      if (body.action === "recover") {
        if (!body.recipient) {
          throw new Error("recipient is required for recover");
        }

        return runtimeSdk.recoverSessionAssets(body.agentId!, body.recipient, {
          keepSuiGas: body.keepSuiGas,
          coinTypes: body.coinTypes,
        });
      }

      return {
        agent: sanitizeAgent(runtimeSdk.markLocalAgentRevoked(body.agentId!, body.revokedAt)),
      };
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to handle session lifecycle action", 500, error instanceof Error ? error.message : String(error));
  }
}

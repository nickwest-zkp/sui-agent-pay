import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type LocalRuntimeSdk = {
  getWalletAddress(secretKey: string): Promise<string>;
  registerLocalAgent(params: {
    label: string;
    agentType: "long_lived" | "temporary";
    userId: string;
    sessionKey: string;
    sessionKeyPrivate?: string;
    vaultId?: string;
    coinType?: string;
    allowedRecipients?: string[];
    allowedTokens?: string[];
    overrides?: Partial<{
      maxPerTx: string;
      maxTotal: string;
      dailyBudget: string;
      weeklyBudget: string;
      validity: number;
      approvalThreshold: string;
    }>;
    createdAt?: string;
    agentId?: string;
    policyId?: string;
  }): {
    agent: {
      agentId: string;
      label: string;
      agentType: "long_lived" | "temporary";
      userId: string;
      sessionKey: string;
      sessionKeyPrivate?: string;
      vaultId: string;
      coinType: string;
      createdAt: string;
      revokedAt?: string;
    };
    policy: unknown;
  };
  listAgents(): Array<{
    agentId: string;
    label: string;
    agentType: "long_lived" | "temporary";
    userId: string;
    sessionKey: string;
    sessionKeyPrivate?: string;
    vaultId: string;
    coinType: string;
    createdAt: string;
    revokedAt?: string;
  }>;
  getSessionInfo(agentId: string): unknown;
};

function sanitizeAgent(agent: {
  agentId: string;
  label: string;
  agentType: "long_lived" | "temporary";
  userId: string;
  sessionKey: string;
  sessionKeyPrivate?: string;
  vaultId: string;
  coinType: string;
  createdAt: string;
  revokedAt?: string;
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
    const includeSession = searchParams.get("includeSession") === "true";

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as LocalRuntimeSdk;
      const agents = runtimeSdk.listAgents();
      return agents.map(agent => ({
        ...sanitizeAgent(agent),
        ...(includeSession ? { session: runtimeSdk.getSessionInfo(agent.agentId) } : {}),
      }));
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to load agents", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      label?: string;
      agentType?: "long_lived" | "temporary";
      userId?: string;
      sessionKey?: string;
      sessionKeyPrivate?: string;
      vaultId?: string;
      coinType?: string;
      allowedRecipients?: string[];
      allowedTokens?: string[];
      overrides?: Partial<{
        maxPerTx: string;
        maxTotal: string;
        dailyBudget: string;
        weeklyBudget: string;
        validity: number;
        approvalThreshold: string;
      }>;
      createdAt?: string;
      agentId?: string;
      policyId?: string;
    };

    if (!body.label || !body.agentType || !body.userId || !body.sessionKey) {
      return fail("label, agentType, userId, and sessionKey are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as LocalRuntimeSdk;
      if (body.sessionKeyPrivate) {
        const derivedAddress = await runtimeSdk.getWalletAddress(body.sessionKeyPrivate);
        if (derivedAddress.toLowerCase() !== body.sessionKey!.toLowerCase()) {
          throw new Error("sessionKeyPrivate does not match sessionKey");
        }
      }

      const result = runtimeSdk.registerLocalAgent({
        label: body.label!,
        agentType: body.agentType!,
        userId: body.userId!,
        sessionKey: body.sessionKey!,
        sessionKeyPrivate: body.sessionKeyPrivate,
        vaultId: body.vaultId,
        coinType: body.coinType,
        allowedRecipients: body.allowedRecipients,
        allowedTokens: body.allowedTokens,
        overrides: body.overrides,
        createdAt: body.createdAt,
        agentId: body.agentId,
        policyId: body.policyId,
      });

      return {
        agent: sanitizeAgent(result.agent),
        policy: result.policy,
      };
    });

    return ok(data, { status: 201 });
  } catch (error) {
    return fail("Failed to register local agent", 500, error instanceof Error ? error.message : String(error));
  }
}

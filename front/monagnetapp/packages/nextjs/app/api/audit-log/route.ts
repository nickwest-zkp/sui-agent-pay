import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    const limit = Number(searchParams.get("limit") || "20");

    const data = await withSdk(async sdk => (agentId ? sdk.getAuditLog(agentId, limit) : sdk.getRecentAuditLog(limit)));
    return ok(data);
  } catch (error) {
    return fail("Failed to load audit log", 500, error instanceof Error ? error.message : String(error));
  }
}

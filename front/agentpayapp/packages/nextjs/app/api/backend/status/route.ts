import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await withSdk(async sdk => sdk.getSystemStatus());
    return ok(data);
  } catch (error) {
    return fail("Failed to load backend status", 500, error instanceof Error ? error.message : String(error));
  }
}

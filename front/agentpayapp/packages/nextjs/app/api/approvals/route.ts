import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type RuntimeSdk = {
  listApprovalRequests(limit?: number): unknown[];
  getApprovalRequestByToken(token: string): unknown;
  approvePaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): Promise<unknown>;
  rejectPaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): unknown;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");
    const limitValue = Number(searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 20;

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      if (token) {
        const approval = runtimeSdk.getApprovalRequestByToken(token);
        if (!approval) {
          throw new Error("Approval request not found");
        }
        return approval;
      }
      return runtimeSdk.listApprovalRequests(limit);
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to load approval requests", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      token?: string;
      action?: "approve" | "reject";
      note?: string;
      requestedBy?: string;
    };

    if (!body.token || !body.action) {
      return fail("token and action are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      if (body.action === "approve") {
        return runtimeSdk.approvePaymentRequest(body.token!, {
          note: body.note,
          requestedBy: body.requestedBy,
        });
      }

      return runtimeSdk.rejectPaymentRequest(body.token!, {
        note: body.note,
        requestedBy: body.requestedBy,
      });
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to handle approval request", 500, error instanceof Error ? error.message : String(error));
  }
}

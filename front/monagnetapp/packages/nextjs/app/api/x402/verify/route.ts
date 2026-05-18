import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      receiptHeader?: string;
      serviceId?: string;
    };

    if (!body.receiptHeader || !body.serviceId) {
      return fail("receiptHeader and serviceId are required");
    }

    const data = await withSdk(async sdk => sdk.verifyIncomingPayment(body.receiptHeader!, body.serviceId!));

    return ok(data);
  } catch (error) {
    return fail("Failed to verify payment receipt", 500, error instanceof Error ? error.message : String(error));
  }
}

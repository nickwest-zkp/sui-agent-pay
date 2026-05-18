import { randomUUID } from "crypto";
import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await withSdk(async sdk => sdk.listPaidServices());
    return ok(data);
  } catch (error) {
    return fail("Failed to load paid services", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      ownerAgentId?: string;
      url?: string;
      description?: string;
      priceAmount?: string;
      priceToken?: string;
      payToAddress?: string;
      network?: string;
      scheme?: string;
    };

    if (!body.url || !body.description || !body.priceAmount || !body.priceToken || !body.payToAddress) {
      return fail("url, description, priceAmount, priceToken and payToAddress are required");
    }

    const data = await withSdk(async sdk => {
      const status = sdk.getSystemStatus();
      const service = {
        serviceId: randomUUID(),
        ownerAgentId: body.ownerAgentId,
        url: body.url!,
        description: body.description!,
        priceAmount: body.priceAmount!,
        priceToken: body.priceToken!,
        payToAddress: body.payToAddress!,
        network: body.network ?? status.network,
        scheme: body.scheme ?? "exact",
        createdAt: new Date().toISOString(),
      };

      sdk.registerPaidService(service);
      return service;
    });

    return ok(data, { status: 201 });
  } catch (error) {
    return fail("Failed to register paid service", 500, error instanceof Error ? error.message : String(error));
  }
}

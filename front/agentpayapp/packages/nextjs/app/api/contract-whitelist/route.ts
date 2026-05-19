import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type RuntimeSdk = {
  listContractWhitelist(walletAddress?: string): Array<{
    entryId: string;
    walletAddress: string;
    packageId: string;
    label?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  upsertContractWhitelist(walletAddress: string, packageId: string, label?: string): {
    entryId: string;
    walletAddress: string;
    packageId: string;
    label?: string;
    createdAt: string;
    updatedAt: string;
  };
  removeContractWhitelist(walletAddress: string, packageId: string): boolean;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get("walletAddress") ?? undefined;
    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.listContractWhitelist(walletAddress);
    });
    return ok(data);
  } catch (error) {
    return fail("Failed to load contract whitelist", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      walletAddress?: string;
      packageId?: string;
      label?: string;
    };

    if (!body.walletAddress || !body.packageId) {
      return fail("walletAddress and packageId are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.upsertContractWhitelist(body.walletAddress!, body.packageId!, body.label);
    });

    return ok(data, { status: 201 });
  } catch (error) {
    return fail("Failed to save contract whitelist entry", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as {
      walletAddress?: string;
      packageId?: string;
    };

    if (!body.walletAddress || !body.packageId) {
      return fail("walletAddress and packageId are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.removeContractWhitelist(body.walletAddress!, body.packageId!);
    });

    return ok({ removed: data });
  } catch (error) {
    return fail("Failed to delete contract whitelist entry", 500, error instanceof Error ? error.message : String(error));
  }
}

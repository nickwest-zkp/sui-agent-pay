import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";

export const runtime = "nodejs";

type RuntimeSdk = {
  listTelegramBindings(): unknown[];
  getTelegramBindingByWalletAddress(walletAddress: string): unknown;
  upsertTelegramBinding(walletAddress: string, chatId: string): unknown;
  removeTelegramBinding(walletAddress: string): boolean;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get("walletAddress");

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      if (walletAddress) {
        const binding = runtimeSdk.getTelegramBindingByWalletAddress(walletAddress);
        if (!binding) {
          throw new Error("Telegram binding not found");
        }
        return binding;
      }

      return runtimeSdk.listTelegramBindings();
    });

    return ok(data);
  } catch (error) {
    return fail("Failed to load Telegram bindings", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      walletAddress?: string;
      chatId?: string;
    };

    if (!body.walletAddress || !body.chatId) {
      return fail("walletAddress and chatId are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.upsertTelegramBinding(body.walletAddress!, body.chatId!);
    });

    return ok(data, { status: 201 });
  } catch (error) {
    return fail("Failed to save Telegram binding", 500, error instanceof Error ? error.message : String(error));
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as {
      walletAddress?: string;
    };

    if (!body.walletAddress) {
      return fail("walletAddress is required");
    }

    const removed = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      return runtimeSdk.removeTelegramBinding(body.walletAddress!);
    });

    if (!removed) {
      return fail("Telegram binding not found", 404);
    }

    return ok({ removed: true });
  } catch (error) {
    return fail("Failed to delete Telegram binding", 500, error instanceof Error ? error.message : String(error));
  }
}

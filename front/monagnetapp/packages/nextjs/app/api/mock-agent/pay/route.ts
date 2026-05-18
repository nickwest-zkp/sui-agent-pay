import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";
import { buildDemoAgentTrace, createTaskId, parseTransferInstruction } from "~~/lib/server/demo-agent";

export const runtime = "nodejs";

type AgentRuntimeSdk = {
  getSystemStatus(): { coinType: string };
  getTelegramBindingByWalletAddress(walletAddress: string): { chatId: string } | null;
  requestPaymentForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    recipient: string;
    token: string;
    amount: string;
  }): Promise<unknown>;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      agentId?: string;
      instruction?: string;
      coinType?: string;
      coinDecimals?: number;
      chatId?: string;
      walletAddress?: string;
    };

    if (!body.agentId || !body.instruction) {
      return fail("agentId and instruction are required");
    }

    const coinDecimals =
      typeof body.coinDecimals === "number" && Number.isFinite(body.coinDecimals) && body.coinDecimals >= 0
        ? Math.floor(body.coinDecimals)
        : 9;

    const parsed = parseTransferInstruction(body.instruction, coinDecimals);
    const taskId = createTaskId();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as AgentRuntimeSdk;
      const paymentResult = await runtimeSdk.requestPaymentForAgent({
        taskId,
        agentId: body.agentId!,
        reason: parsed.reason,
        recipient: parsed.recipient,
        token: body.coinType ?? runtimeSdk.getSystemStatus().coinType,
        amount: parsed.amount,
      });

      return {
        agent: {
          mode: "tool-driven-demo",
          taskId,
          trace: buildDemoAgentTrace({
            instruction: body.instruction!,
            parsed,
            agentId: body.agentId!,
          }),
        },
        parsed,
        paymentResult,
        resolvedChatId:
          body.chatId?.trim() ||
          (body.walletAddress ? runtimeSdk.getTelegramBindingByWalletAddress(body.walletAddress)?.chatId ?? "" : ""),
      };
    });

    const approvalRequest = (data as { paymentResult?: { approvalRequest?: { approvalToken: string } } }).paymentResult
      ?.approvalRequest;
    const resolvedChatId = (data as { resolvedChatId?: string }).resolvedChatId ?? "";
    let telegram: unknown = undefined;

    if (approvalRequest?.approvalToken) {
      const appBaseUrl =
        process.env.NEXT_PUBLIC_APP_BASE_URL ??
        process.env.APP_BASE_URL ??
        "http://localhost:3000";

      if (!resolvedChatId) {
        telegram = {
          sent: false,
          error: "No Telegram chat ID was provided and no binding was found for the wallet address.",
        };
      } else {
        try {
          const response = await fetch(`${appBaseUrl}/api/tg/approve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              approvalToken: approvalRequest.approvalToken,
              text: `Approval required for agent ${body.agentId}: ${parsed.amountInput} to ${parsed.recipient}. Reason: ${parsed.reason}`,
              chatId: resolvedChatId,
              walletAddress: body.walletAddress,
            }),
          });

          const responseJson = await response.json();
          telegram = response.ok
            ? responseJson
            : {
                sent: false,
                error: responseJson?.error ?? "Telegram approval request failed",
                details: responseJson?.details,
              };
        } catch (telegramError) {
          telegram = {
            sent: false,
            error: telegramError instanceof Error ? telegramError.message : String(telegramError),
          };
        }
      }
    }

    return ok({
      ...data,
      telegram,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isUserError =
      message.includes("Agent not found") ||
      message.includes("session private key is not stored locally") ||
      message.includes("Could not find a recipient address") ||
      message.includes("Could not find an amount") ||
      message.includes("Instruction is empty") ||
      message.includes("Amount is missing") ||
      message.includes("Amount format is invalid") ||
      message.includes("decimal places");

    return fail("Demo agent failed to process instruction", isUserError ? 400 : 500, message);
  }
}

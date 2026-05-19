import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";
import { buildDeepBookSwapMetadata } from "~~/lib/deepbook";
import { buildDemoAgentTrace, createTaskId, parseAgentInstruction } from "~~/lib/server/demo-agent";

export const runtime = "nodejs";

type AgentRuntimeSdk = {
  getSystemStatus(): { coinType: string; network: string };
  getTelegramBindingByWalletAddress(walletAddress: string): { chatId: string } | null;
  requestPaymentForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    recipient: string;
    token: string;
    amount: string;
  }): Promise<unknown>;
  requestContractCallForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    contractCall: {
      packageId: string;
      module: string;
      functionName: string;
      typeArguments: string[];
      arguments: Array<{
        kind: "object" | "address" | "u64" | "string" | "bool";
        value: string | boolean;
      }>;
      walletAddress?: string;
    };
  }): Promise<unknown>;
  requestDeepBookSwapForAgent(intent: {
    taskId: string;
    agentId: string;
    reason: string;
    deepbookSwap: {
      packageId: string;
      walletAddress?: string;
      inputCoinType: string;
      outputCoinType: string;
      inputAmount: string;
      deepCoinType: string;
      route: Array<{
        poolId: string;
        baseCoinType: string;
        quoteCoinType: string;
        direction: "base_to_quote" | "quote_to_base";
        minOutputAmount: string;
      }>;
    };
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

    const parsed = parseAgentInstruction(body.instruction, coinDecimals);
    const taskId = createTaskId();

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as AgentRuntimeSdk;
      const paymentResult =
        parsed.kind === "contract_call"
          ? await runtimeSdk.requestContractCallForAgent({
              taskId,
              agentId: body.agentId!,
              reason: parsed.reason,
              contractCall: {
                packageId: parsed.packageId,
                module: parsed.module,
                functionName: parsed.functionName,
                typeArguments: parsed.typeArguments,
                arguments: parsed.arguments,
                walletAddress: body.walletAddress,
              },
            })
          : parsed.kind === "deepbook_swap"
            ? await runtimeSdk.requestDeepBookSwapForAgent({
                taskId,
                agentId: body.agentId!,
                reason: parsed.reason,
                deepbookSwap: buildDeepBookSwapMetadata({
                  network: runtimeSdk.getSystemStatus().network,
                  inputSymbol: parsed.inputSymbol,
                  outputSymbol: parsed.outputSymbol,
                  inputAmount: parsed.amount,
                  walletAddress: body.walletAddress,
                }),
              })
          : await runtimeSdk.requestPaymentForAgent({
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
              text:
                parsed.kind === "contract_call"
                  ? `Approval required for agent ${body.agentId}: call ${parsed.target}. Reason: ${parsed.reason}`
                  : parsed.kind === "deepbook_swap"
                    ? `Approval required for agent ${body.agentId}: swap ${parsed.amountInput} ${parsed.inputSymbol} to ${parsed.outputSymbol} via DeepBook. Reason: ${parsed.reason}`
                  : `Approval required for agent ${body.agentId}: ${parsed.amountInput} to ${parsed.recipient}. Reason: ${parsed.reason}`,
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
      message.includes("session key is revoked") ||
      message.includes("session key is expired") ||
      message.includes("Could not find a recipient address") ||
      message.includes("Could not find an amount") ||
      message.includes("type arguments must be valid JSON") ||
      message.includes("contract arguments must be valid JSON") ||
      message.includes("must be a JSON array") ||
      message.includes("Instruction is empty") ||
      message.includes("Amount is missing") ||
      message.includes("Amount format is invalid") ||
      message.includes("decimal places") ||
      message.includes("DeepBook");

    return fail("Demo agent failed to process instruction", isUserError ? 400 : 500, message);
  }
}

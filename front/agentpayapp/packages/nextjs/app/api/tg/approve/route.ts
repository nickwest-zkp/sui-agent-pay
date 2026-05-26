import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";
import { notifyTelegram, sendTelegramApprovalRequest } from "~~/lib/server/telegram";

export const runtime = "nodejs";

type RuntimeSdk = {
  getApprovalRequestByToken(token: string): unknown;
  approvePaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): Promise<unknown>;
  rejectPaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): unknown;
};

function wantsHtml(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

function renderHtml(title: string, body: string, tone: "success" | "error" | "info" = "info") {
  const palette =
    tone === "success"
      ? { border: "#16a34a", background: "#f0fdf4", text: "#166534" }
      : tone === "error"
        ? { border: "#dc2626", background: "#fef2f2", text: "#991b1b" }
        : { border: "#2563eb", background: "#eff6ff", text: "#1d4ed8" };

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: Inter, Arial, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        display: flex;
        min-height: 100vh;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .panel {
        width: min(680px, 100%);
        border-radius: 20px;
        padding: 24px;
        background: #111827;
        border: 1px solid rgba(148, 163, 184, 0.2);
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.32);
      }
      .status {
        border-left: 4px solid ${palette.border};
        background: ${palette.background};
        color: ${palette.text};
        border-radius: 12px;
        padding: 14px 16px;
        margin-top: 16px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      h1 { margin: 0; font-size: 24px; }
      p { margin: 12px 0 0; color: #94a3b8; line-height: 1.6; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>${title}</h1>
      <p>The approval callback was processed by the local demo runtime.</p>
      <div class="status">${body}</div>
    </main>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");
    const action = searchParams.get("action");

    if (!token || (action !== "approve" && action !== "reject")) {
      return fail("token and action are required");
    }

    const data = await withSdk(async sdk => {
      const runtimeSdk = sdk as unknown as RuntimeSdk;
      const approval = runtimeSdk.getApprovalRequestByToken(token);
      if (!approval) {
        throw new Error("Approval request not found");
      }

      return action === "approve"
        ? runtimeSdk.approvePaymentRequest(token, { requestedBy: "telegram-link" })
        : runtimeSdk.rejectPaymentRequest(token, { requestedBy: "telegram-link" });
    });

    const approvalData = data as { status?: string; txHash?: string; approvalId?: string; agentId?: string };
    const status = approvalData.status ?? (action === "approve" ? "approved" : "rejected");
    const txLine = approvalData.txHash ? `\nTransaction: ${approvalData.txHash}` : "";
    const summary = `Approval ${status} for agent ${approvalData.agentId ?? "unknown"}.\nApproval ID: ${approvalData.approvalId ?? "n/a"}${txLine}`;

    try {
      await notifyTelegram(summary);
    } catch {
      // Best effort only. Approval execution should not fail because the confirmation message could not be delivered.
    }

    if (wantsHtml(request)) {
      return renderHtml(
        action === "approve" ? "Approval Processed" : "Request Rejected",
        summary,
        status === "executed" || status === "approved" ? "success" : "info",
      );
    }

    return ok(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsHtml(request)) {
      return renderHtml("Approval Failed", message, "error");
    }
    return fail("Failed to process Telegram approval callback", 500, message);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      approvalToken?: string;
      text?: string;
      chatId?: string;
      walletAddress?: string;
    };

    if (!body.approvalToken) {
      return fail("approvalToken is required");
    }

    return ok(
      await sendTelegramApprovalRequest({
        approvalToken: body.approvalToken,
        text: body.text,
        chatId: body.chatId,
        walletAddress: body.walletAddress,
      }),
    );
  } catch (error) {
    return fail("Failed to send Telegram approval request", 500, error instanceof Error ? error.message : String(error));
  }
}

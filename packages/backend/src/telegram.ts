import https from "https";

async function sendTelegramRequest(url: string, body: string) {
  return new Promise<unknown>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`Telegram sendMessage failed with status ${res.statusCode}: ${raw}`));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export function getAppBaseUrl() {
  return process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_BASE_URL ?? "http://localhost:3000";
}

function isTelegramInlineButtonUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
  } catch {
    return false;
  }
}

export async function notifyTelegram(
  text: string,
  chatIdOverride?: string,
  options?: {
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
  },
) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return {
      skipped: true,
      reason: !botToken
        ? "TELEGRAM_BOT_TOKEN is not configured."
        : "No Telegram chat ID was provided and TELEGRAM_CHAT_ID is not configured.",
    };
  }

  return sendTelegramRequest(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    JSON.stringify({
      chat_id: chatId,
      text,
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    }),
  );
}

export async function sendTelegramApprovalRequest(input: {
  approvalToken: string;
  text?: string;
  chatId?: string;
  walletAddress?: string;
  state?: unknown;
}) {
  const appBaseUrl = getAppBaseUrl();
  const stateParam = input.state
    ? `&state=${Buffer.from(JSON.stringify(input.state), "utf8").toString("base64url")}`
    : "";
  const approveUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(input.approvalToken)}&action=approve${stateParam}`;
  const rejectUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(input.approvalToken)}&action=reject${stateParam}`;
  const supportsInlineButtons = isTelegramInlineButtonUrl(approveUrl) && isTelegramInlineButtonUrl(rejectUrl);

  const messageLines = [input.text ?? "Payment approval required"];
  if (input.chatId) messageLines.push(`Telegram Chat ID: ${input.chatId}`);
  if (input.walletAddress) messageLines.push(`Wallet: ${input.walletAddress}`);
  messageLines.push(`Approval token: ${input.approvalToken.slice(0, 12)}...${input.approvalToken.slice(-8)}`);
  if (supportsInlineButtons) {
    messageLines.push("Use the buttons below to approve or reject.");
  } else {
    messageLines.push(`Approve: ${approveUrl}`);
    messageLines.push(`Reject: ${rejectUrl}`);
    messageLines.push("Inline buttons are disabled because APP_BASE_URL must be a public HTTPS URL for Telegram.");
  }

  const telegramResult = await notifyTelegram(
    messageLines.join("\n"),
    input.chatId,
    supportsInlineButtons
      ? {
          replyMarkup: {
            inline_keyboard: [[
              { text: "Approve", url: approveUrl },
              { text: "Reject", url: rejectUrl },
            ]],
          },
        }
      : undefined,
  );
  const skippedReason =
    telegramResult &&
    typeof telegramResult === "object" &&
    "skipped" in telegramResult &&
    (telegramResult as { skipped?: boolean }).skipped
      ? (telegramResult as { reason?: string }).reason ?? "Telegram delivery was skipped."
      : null;

  return {
    sent: skippedReason ? false : true,
    ...(skippedReason ? { error: skippedReason } : {}),
    approveUrl,
    rejectUrl,
    telegramResult,
  };
}

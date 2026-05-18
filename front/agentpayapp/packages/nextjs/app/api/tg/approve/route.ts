import { withSdk } from "~~/lib/server/agent-pay-sdk";
import { fail, ok } from "~~/lib/server/api";
import https from "https";
import net from "net";
import { Duplex } from "stream";
import tls from "tls";

export const runtime = "nodejs";

type RuntimeSdk = {
  getApprovalRequestByToken(token: string): unknown;
  approvePaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): Promise<unknown>;
  rejectPaymentRequest(token: string, options?: { note?: string; requestedBy?: string }): unknown;
};

class HttpConnectProxyAgent extends https.Agent {
  private proxy: URL;
  private targetHost: string;
  private targetPort: number;

  constructor(proxyUrl: string, targetHost: string, targetPort: number) {
    super({ keepAlive: true });
    this.proxy = new URL(proxyUrl);
    this.targetHost = targetHost;
    this.targetPort = targetPort;
  }

  override createConnection(
    _options: unknown,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex {
    const proxy = this.proxy;
    const targetHost = this.targetHost;
    const targetPort = this.targetPort;
    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const socket = net.connect(proxyPort, proxy.hostname);

    socket.once("error", error => callback?.(error as Error, socket));
    socket.once("connect", () => {
      let connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;

      if (proxy.username || proxy.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
        connectRequest += `Proxy-Authorization: Basic ${auth}\r\n`;
      }

      connectRequest += "\r\n";
      socket.write(connectRequest);
    });

    let responseBuffer = "";
    const onData = (chunk: Buffer) => {
      responseBuffer += chunk.toString("utf8");
      if (!responseBuffer.includes("\r\n\r\n")) {
        return;
      }

      socket.off("data", onData);
      const statusLine = responseBuffer.split("\r\n", 1)[0] ?? "";
      if (!statusLine.includes(" 200 ")) {
        socket.destroy();
        callback?.(new Error(`Telegram proxy CONNECT failed: ${statusLine}`), socket);
        return;
      }

      const tlsSocket = tls.connect(
        {
          socket,
          servername: targetHost,
        },
        () => callback?.(null, tlsSocket),
      );

      tlsSocket.once("error", error => callback?.(error as Error, tlsSocket));
    };

    socket.on("data", onData);
    return socket as unknown as tls.TLSSocket;
  }
}

class Socks5ProxyAgent extends https.Agent {
  private proxy: URL;
  private targetHost: string;
  private targetPort: number;

  constructor(proxyUrl: string, targetHost: string, targetPort: number) {
    super({ keepAlive: true });
    this.proxy = new URL(proxyUrl);
    this.targetHost = targetHost;
    this.targetPort = targetPort;
  }

  override createConnection(
    _options: unknown,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex {
    const proxy = this.proxy;
    const targetHost = this.targetHost;
    const targetPort = this.targetPort;
    const proxyPort = Number(proxy.port || 1080);
    const socket = net.connect(proxyPort, proxy.hostname);

    socket.once("error", error => callback?.(error as Error, socket));
    socket.once("connect", () => {
      const needsAuth = Boolean(proxy.username || proxy.password);
      socket.write(Buffer.from([0x05, 0x01, needsAuth ? 0x02 : 0x00]));
    });

    let stage: "method" | "auth" | "connect" | "done" = "method";
    const onData = (chunk: Buffer) => {
      if (stage === "method") {
        if (chunk.length < 2 || chunk[0] !== 0x05) {
          socket.destroy();
          callback?.(new Error("Invalid SOCKS5 proxy response"), socket);
          return;
        }

        if (chunk[1] === 0xff) {
          socket.destroy();
          callback?.(new Error("SOCKS5 proxy rejected authentication methods"), socket);
          return;
        }

        if (chunk[1] === 0x02) {
          stage = "auth";
          const username = decodeURIComponent(proxy.username);
          const password = decodeURIComponent(proxy.password);
          const usernameBytes = Buffer.from(username);
          const passwordBytes = Buffer.from(password);
          socket.write(
            Buffer.concat([
              Buffer.from([0x01, usernameBytes.length]),
              usernameBytes,
              Buffer.from([passwordBytes.length]),
              passwordBytes,
            ]),
          );
          return;
        }

        stage = "connect";
        const hostBytes = Buffer.from(targetHost, "utf8");
        const portBytes = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
            hostBytes,
            portBytes,
          ]),
        );
        return;
      }

      if (stage === "auth") {
        if (chunk.length < 2 || chunk[1] !== 0x00) {
          socket.destroy();
          callback?.(new Error("SOCKS5 proxy authentication failed"), socket);
          return;
        }

        stage = "connect";
        const hostBytes = Buffer.from(targetHost, "utf8");
        const portBytes = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
            hostBytes,
            portBytes,
          ]),
        );
        return;
      }

      if (stage === "connect") {
        if (chunk.length < 2 || chunk[1] !== 0x00) {
          socket.destroy();
          callback?.(new Error(`SOCKS5 proxy connect failed with code ${chunk[1] ?? "unknown"}`), socket);
          return;
        }

        stage = "done";
        socket.off("data", onData);

        const tlsSocket = tls.connect(
          {
            socket,
            servername: targetHost,
          },
          () => callback?.(null, tlsSocket),
        );

        tlsSocket.once("error", error => callback?.(error as Error, tlsSocket));
      }
    };

    socket.on("data", onData);
    return socket as unknown as tls.TLSSocket;
  }
}

function createProxyAgent(proxyUrl: string, targetHost: string, targetPort: number) {
  if (proxyUrl.startsWith("socks5://")) {
    return new Socks5ProxyAgent(proxyUrl, targetHost, targetPort);
  }
  return new HttpConnectProxyAgent(proxyUrl, targetHost, targetPort);
}

async function sendTelegramRequestViaSocks(url: string, body: string, proxyUrl: string) {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  const host = target.hostname;
  const port = Number(target.port || 443);
  const path = `${target.pathname}${target.search}`;

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(Number(proxy.port || 1080), proxy.hostname);
    let stage: "method" | "connect" | "done" = "method";
    let buffer = Buffer.alloc(0);

    const failSocket = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.once("error", failSocket);
    socket.once("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "method") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05 || buffer[1] === 0xff) {
          failSocket(new Error("SOCKS5 proxy rejected authentication method"));
          return;
        }

        buffer = Buffer.alloc(0);
        stage = "connect";
        const hostBytes = Buffer.from(host, "utf8");
        const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
        socket.write(
          Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]), hostBytes, portBytes]),
        );
        return;
      }

      if (stage === "connect") {
        if (buffer.length < 5) return;
        if (buffer[1] !== 0x00) {
          failSocket(new Error(`SOCKS5 proxy connect failed with code ${buffer[1]}`));
          return;
        }

        stage = "done";
        socket.removeAllListeners("data");

        const tlsSocket = tls.connect(
          {
            socket,
            servername: host,
          },
          () => {
            const request =
              `POST ${path} HTTP/1.1\r\n` +
              `Host: ${host}\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n` +
              `Connection: close\r\n\r\n` +
              body;
            tlsSocket.write(request);
          },
        );

        let raw = "";
        tlsSocket.on("data", data => {
          raw += data.toString("utf8");
        });
        tlsSocket.on("end", () => {
          const [headerBlock, responseBody = ""] = raw.split("\r\n\r\n");
          const statusLine = headerBlock?.split("\r\n", 1)[0] ?? "";
          const statusMatch = statusLine.match(/^HTTP\/1\.1\s+(\d+)/);
          const statusCode = statusMatch ? Number(statusMatch[1]) : 500;

          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Telegram sendMessage failed with status ${statusCode}: ${responseBody}`));
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve(responseBody);
          }
        });
        tlsSocket.on("error", reject);
      }
    });
  });
}

async function sendTelegramRequest(url: string, body: string) {
  const target = new URL(url);
  const proxyUrl = process.env.TELEGRAM_PROXY_URL;

  if (proxyUrl?.startsWith("socks5://")) {
    return sendTelegramRequestViaSocks(url, body, proxyUrl);
  }

  return new Promise<unknown>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        agent: proxyUrl ? createProxyAgent(proxyUrl, target.hostname, Number(target.port || 443)) : undefined,
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

async function notifyTelegram(text: string, chatIdOverride?: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return { skipped: true };
  }

  return sendTelegramRequest(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    JSON.stringify({
      chat_id: chatId,
      text,
    }),
  );
}

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

    const appBaseUrl =
      process.env.NEXT_PUBLIC_APP_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3000";

    const approveUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(body.approvalToken)}&action=approve`;
    const rejectUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(body.approvalToken)}&action=reject`;

    const messageLines = [body.text ?? "Payment approval required"];
    if (body.chatId) {
      messageLines.push(`Telegram Chat ID: ${body.chatId}`);
    }
    if (body.walletAddress) {
      messageLines.push(`Wallet: ${body.walletAddress}`);
    }
    messageLines.push(`Approve: ${approveUrl}`);
    messageLines.push(`Reject: ${rejectUrl}`);

    const message = messageLines.join("\n");
    const telegramResult = await notifyTelegram(message, body.chatId);

    return ok({
      sent: true,
      approveUrl,
      rejectUrl,
      telegramResult,
    });
  } catch (error) {
    return fail("Failed to send Telegram approval request", 500, error instanceof Error ? error.message : String(error));
  }
}

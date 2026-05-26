import https from "https";
import net from "net";
import { Duplex } from "stream";
import tls from "tls";

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

export function getAppBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
}

function isTelegramInlineButtonUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }

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
}) {
  const appBaseUrl = getAppBaseUrl();
  const approveUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(input.approvalToken)}&action=approve`;
  const rejectUrl = `${appBaseUrl}/api/tg/approve?token=${encodeURIComponent(input.approvalToken)}&action=reject`;
  const supportsInlineButtons = isTelegramInlineButtonUrl(approveUrl) && isTelegramInlineButtonUrl(rejectUrl);

  const messageLines = [input.text ?? "Payment approval required"];
  if (input.chatId) {
    messageLines.push(`Telegram Chat ID: ${input.chatId}`);
  }
  if (input.walletAddress) {
    messageLines.push(`Wallet: ${input.walletAddress}`);
  }
  messageLines.push(`Approve: ${approveUrl}`);
  messageLines.push(`Reject: ${rejectUrl}`);
  if (!supportsInlineButtons) {
    messageLines.push("Inline buttons are disabled because APP_BASE_URL must be a public HTTPS URL for Telegram.");
  }

  const telegramResult = await notifyTelegram(messageLines.join("\n"), input.chatId, supportsInlineButtons
    ? {
        replyMarkup: {
          inline_keyboard: [[
            { text: "Approve", url: approveUrl },
            { text: "Reject", url: rejectUrl },
          ]],
        },
      }
    : undefined);
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

import { randomUUID } from "crypto";
import http from "http";
import { getSdk } from "./config";
import type { ApprovalRequest } from "@sui-agent-pay/sdk";
import { fail, ok, readJson } from "./api";
import { buildDeepBookSwapMetadata } from "./deepbook";
import { buildDemoAgentTrace, createTaskId, parseAgentInstruction } from "./demo-agent";
import { notifyTelegram, sendTelegramApprovalRequest } from "./telegram";

type Handler = (request: Request, url: URL) => Promise<Response> | Response;

type Route = {
  method: string;
  path: string;
  handler: Handler;
};

type RuntimeAgentSeed = {
  label?: string;
  agentType?: "long_lived" | "temporary";
  userId?: string;
  sessionKey?: string;
  sessionKeyPrivate?: string;
  vaultId?: string;
  coinType?: string;
  allowedRecipients?: string[];
  allowedTokens?: string[];
  overrides?: Partial<{
    maxPerTx: string;
    maxTotal: string;
    dailyBudget: string;
    weeklyBudget: string;
    validity: number;
    approvalThreshold: string;
  }>;
  createdAt?: string;
  agentId?: string;
  policyId?: string;
};

type ApprovalState = {
  approval?: ApprovalRequest;
  runtimeAgent?: RuntimeAgentSeed;
};

function sanitizeAgent(agent: {
  agentId: string;
  label: string;
  agentType: "long_lived" | "temporary";
  userId: string;
  sessionKey: string;
  sessionKeyPrivate?: string;
  vaultId: string;
  coinType: string;
  createdAt: string;
  revokedAt?: string;
}) {
  return {
    agentId: agent.agentId,
    label: agent.label,
    agentType: agent.agentType,
    userId: agent.userId,
    sessionKey: agent.sessionKey,
    vaultId: agent.vaultId,
    coinType: agent.coinType,
    createdAt: agent.createdAt,
    revokedAt: agent.revokedAt,
    hasStoredSessionKey: Boolean(agent.sessionKeyPrivate),
  };
}

function ensureRuntimeAgent(sdk: ReturnType<typeof getSdk>, agentId: string, seed?: RuntimeAgentSeed) {
  try {
    sdk.getSessionInfo(agentId);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`Agent not found: ${agentId}`)) {
      throw error;
    }
  }

  if (!seed?.label || !seed.agentType || !seed.userId || !seed.sessionKey || !seed.sessionKeyPrivate || !seed.vaultId) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  sdk.registerLocalAgent({
    label: seed.label,
    agentType: seed.agentType,
    userId: seed.userId,
    sessionKey: seed.sessionKey,
    sessionKeyPrivate: seed.sessionKeyPrivate,
    vaultId: seed.vaultId,
    coinType: seed.coinType,
    allowedRecipients: seed.allowedRecipients,
    allowedTokens: seed.allowedTokens,
    overrides: seed.overrides,
    createdAt: seed.createdAt,
    agentId,
    policyId: seed.policyId,
  });
}

function decodeApprovalState(rawState: string | null): ApprovalState | null {
  if (!rawState) return null;

  try {
    const parsed = JSON.parse(Buffer.from(rawState, "base64url").toString("utf8")) as ApprovalState;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function restoreStatelessApproval(sdk: ReturnType<typeof getSdk>, token: string, state: ApprovalState | null) {
  if (!state?.approval || state.approval.approvalToken !== token) {
    return null;
  }

  ensureRuntimeAgent(sdk, state.approval.agentId, state.runtimeAgent);
  return sdk.restoreApprovalRequest(state.approval);
}

function isUserRuntimeError(message: string) {
  return (
    message.includes("Agent not found") ||
    message.includes("session private key is not stored locally") ||
    message.includes("session key is revoked") ||
    message.includes("session key is expired") ||
    message.includes("does not match the selected agent session key")
  );
}

function wantsHtml(request: Request) {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function renderHtml(title: string, body: string, tone: "success" | "error" | "info" = "info") {
  const color = tone === "success" ? "#16a34a" : tone === "error" ? "#dc2626" : "#2563eb";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title}</title><style>body{margin:0;font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}.panel{width:min(680px,100%);border-radius:20px;padding:24px;background:#111827;border:1px solid rgba(148,163,184,.2)}.status{border-left:4px solid ${color};background:#fff;color:#111827;border-radius:12px;padding:14px 16px;margin-top:16px;white-space:pre-wrap;word-break:break-word}h1{margin:0;font-size:24px}p{color:#94a3b8;line-height:1.6}</style></head><body><main class="panel"><h1>${title}</h1><p>The approval callback was processed by the demo backend.</p><div class="status">${body}</div></main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

const routes: Route[] = [
  {
    method: "GET",
    path: "/api/backend/status",
    handler: () => ok(getSdk().getSystemStatus()),
  },
  {
    method: "GET",
    path: "/api/agents",
    handler: (_request, url) => {
      const includeSession = url.searchParams.get("includeSession") === "true";
      const sdk = getSdk();
      const agents = sdk.listAgents();
      return ok(agents.map(agent => ({
        ...sanitizeAgent(agent),
        ...(includeSession ? { session: sdk.getSessionInfo(agent.agentId) } : {}),
      })));
    },
  },
  {
    method: "POST",
    path: "/api/agents",
    handler: async request => {
      const body = await readJson<{
        label?: string;
        agentType?: "long_lived" | "temporary";
        userId?: string;
        sessionKey?: string;
        sessionKeyPrivate?: string;
        vaultId?: string;
        coinType?: string;
        allowedRecipients?: string[];
        allowedTokens?: string[];
        overrides?: Record<string, unknown>;
        createdAt?: string;
        agentId?: string;
        policyId?: string;
      }>(request);

      if (!body.label || !body.agentType || !body.userId || !body.sessionKey) {
        return fail("label, agentType, userId, and sessionKey are required");
      }

      const sdk = getSdk();
      if (body.sessionKeyPrivate) {
        const derivedAddress = await sdk.getWalletAddress(body.sessionKeyPrivate);
        if (derivedAddress.toLowerCase() !== body.sessionKey.toLowerCase()) {
          throw new Error("sessionKeyPrivate does not match sessionKey");
        }
      }

      const result = sdk.registerLocalAgent({
        label: body.label,
        agentType: body.agentType,
        userId: body.userId,
        sessionKey: body.sessionKey,
        sessionKeyPrivate: body.sessionKeyPrivate,
        vaultId: body.vaultId,
        coinType: body.coinType,
        allowedRecipients: body.allowedRecipients,
        allowedTokens: body.allowedTokens,
        overrides: body.overrides as Parameters<typeof sdk.registerLocalAgent>[0]["overrides"],
        createdAt: body.createdAt,
        agentId: body.agentId,
        policyId: body.policyId,
      });

      return ok({ agent: sanitizeAgent(result.agent), policy: result.policy }, { status: 201 });
    },
  },
  {
    method: "GET",
    path: "/api/audit-log",
    handler: (_request, url) => {
      const agentId = url.searchParams.get("agentId");
      const limit = Number(url.searchParams.get("limit") || "20");
      const sdk = getSdk();
      return ok(agentId ? sdk.getAuditLog(agentId, limit) : sdk.getRecentAuditLog(limit));
    },
  },
  {
    method: "GET",
    path: "/api/approvals",
    handler: (_request, url) => {
      const token = url.searchParams.get("token");
      const limitValue = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 20;
      const sdk = getSdk();
      if (token) {
        const approval = sdk.getApprovalRequestByToken(token);
        if (!approval) throw new Error("Approval request not found");
        return ok(approval);
      }
      return ok(sdk.listApprovalRequests(limit));
    },
  },
  {
    method: "POST",
    path: "/api/approvals",
    handler: async request => {
      const body = await readJson<{ token?: string; action?: "approve" | "reject"; note?: string; requestedBy?: string }>(request);
      if (!body.token || !body.action) return fail("token and action are required");
      const sdk = getSdk();
      return ok(
        body.action === "approve"
          ? await sdk.approvePaymentRequest(body.token, { note: body.note, requestedBy: body.requestedBy })
          : sdk.rejectPaymentRequest(body.token, { note: body.note, requestedBy: body.requestedBy }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/payments",
    handler: async request => {
      const body = await readJson<{
        taskId?: string;
        agentId?: string;
        reason?: string;
        recipient?: string;
        token?: string;
        amount?: string;
        sessionKey?: string;
      }>(request);
      if (!body.agentId || !body.reason || !body.recipient || !body.amount) {
        return fail("agentId, reason, recipient and amount are required");
      }

      const sdk = getSdk();
      const taskId = body.taskId ?? randomUUID();
      const intent = {
        taskId,
        agentId: body.agentId,
        reason: body.reason,
        recipient: body.recipient,
        token: body.token ?? sdk.getSystemStatus().coinType,
        amount: body.amount,
      };
      return ok(body.sessionKey ? await sdk.requestPayment(intent, body.sessionKey) : await sdk.requestPaymentForAgent(intent));
    },
  },
  {
    method: "GET",
    path: "/api/services",
    handler: () => ok(getSdk().listPaidServices()),
  },
  {
    method: "POST",
    path: "/api/services",
    handler: async request => {
      const body = await readJson<{
        ownerAgentId?: string;
        url?: string;
        description?: string;
        priceAmount?: string;
        priceToken?: string;
        payToAddress?: string;
        network?: string;
        scheme?: string;
      }>(request);
      if (!body.url || !body.description || !body.priceAmount || !body.priceToken || !body.payToAddress) {
        return fail("url, description, priceAmount, priceToken and payToAddress are required");
      }

      const sdk = getSdk();
      const status = sdk.getSystemStatus();
      const service = {
        serviceId: randomUUID(),
        ownerAgentId: body.ownerAgentId,
        url: body.url,
        description: body.description,
        priceAmount: body.priceAmount,
        priceToken: body.priceToken,
        payToAddress: body.payToAddress,
        network: body.network ?? status.network,
        scheme: body.scheme ?? "exact",
        createdAt: new Date().toISOString(),
      };
      sdk.registerPaidService(service);
      return ok(service, { status: 201 });
    },
  },
  {
    method: "GET",
    path: "/api/tg-bindings",
    handler: (_request, url) => {
      const walletAddress = url.searchParams.get("walletAddress");
      const sdk = getSdk();
      if (walletAddress) {
        const binding = sdk.getTelegramBindingByWalletAddress(walletAddress);
        if (!binding) throw new Error("Telegram binding not found");
        return ok(binding);
      }
      return ok(sdk.listTelegramBindings());
    },
  },
  {
    method: "POST",
    path: "/api/tg-bindings",
    handler: async request => {
      const body = await readJson<{ walletAddress?: string; chatId?: string }>(request);
      if (!body.walletAddress || !body.chatId) return fail("walletAddress and chatId are required");
      return ok(getSdk().upsertTelegramBinding(body.walletAddress, body.chatId), { status: 201 });
    },
  },
  {
    method: "DELETE",
    path: "/api/tg-bindings",
    handler: async request => {
      const body = await readJson<{ walletAddress?: string }>(request);
      if (!body.walletAddress) return fail("walletAddress is required");
      const removed = getSdk().removeTelegramBinding(body.walletAddress);
      if (!removed) return fail("Telegram binding not found", 404);
      return ok({ removed: true });
    },
  },
  {
    method: "GET",
    path: "/api/contract-whitelist",
    handler: (_request, url) => ok(getSdk().listContractWhitelist(url.searchParams.get("walletAddress") ?? undefined)),
  },
  {
    method: "POST",
    path: "/api/contract-whitelist",
    handler: async request => {
      const body = await readJson<{ walletAddress?: string; packageId?: string; label?: string }>(request);
      if (!body.walletAddress || !body.packageId) return fail("walletAddress and packageId are required");
      return ok(getSdk().upsertContractWhitelist(body.walletAddress, body.packageId, body.label), { status: 201 });
    },
  },
  {
    method: "DELETE",
    path: "/api/contract-whitelist",
    handler: async request => {
      const body = await readJson<{ walletAddress?: string; packageId?: string }>(request);
      if (!body.walletAddress || !body.packageId) return fail("walletAddress and packageId are required");
      return ok({ removed: getSdk().removeContractWhitelist(body.walletAddress, body.packageId) });
    },
  },
  {
    method: "GET",
    path: "/api/agents/session-lifecycle",
    handler: (_request, url) => {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) return fail("agentId is required");
      return getSdk().listSessionAssets(agentId, { keepSuiGas: url.searchParams.get("keepSuiGas") ?? undefined }).then(ok);
    },
  },
  {
    method: "POST",
    path: "/api/agents/session-lifecycle",
    handler: async request => {
      const body = await readJson<{
        action?: "recover" | "mark_revoked";
        agentId?: string;
        recipient?: string;
        keepSuiGas?: string;
        coinTypes?: string[];
        revokedAt?: string;
      }>(request);
      if (!body.action || !body.agentId) return fail("action and agentId are required");
      const sdk = getSdk();
      if (body.action === "recover") {
        if (!body.recipient) throw new Error("recipient is required for recover");
        return ok(await sdk.recoverSessionAssets(body.agentId, body.recipient, {
          keepSuiGas: body.keepSuiGas,
          coinTypes: body.coinTypes,
        }));
      }
      return ok({ agent: sanitizeAgent(sdk.markLocalAgentRevoked(body.agentId, body.revokedAt)) });
    },
  },
  {
    method: "POST",
    path: "/api/agent-runtime/pay",
    handler: async request => {
      const body = await readJson<{ taskId?: string; agentId?: string; reason?: string; recipient?: string; token?: string; amount?: string }>(request);
      if (!body.agentId || !body.reason || !body.recipient || !body.amount) {
        return fail("agentId, reason, recipient and amount are required");
      }
      const sdk = getSdk();
      return ok(await sdk.requestPaymentForAgent({
        taskId: body.taskId ?? randomUUID(),
        agentId: body.agentId,
        reason: body.reason,
        recipient: body.recipient,
        token: body.token ?? sdk.getSystemStatus().coinType,
        amount: body.amount,
      }));
    },
  },
  {
    method: "POST",
    path: "/api/agent-runtime/contract-call",
    handler: async request => {
      const body = await readJson<{
        taskId?: string;
        agentId?: string;
        reason?: string;
        walletAddress?: string;
        packageId?: string;
        module?: string;
        functionName?: string;
        typeArguments?: string[];
        arguments?: Array<{ kind: "object" | "address" | "u64" | "string" | "bool"; value: string | boolean }>;
      }>(request);
      if (!body.agentId || !body.reason || !body.packageId || !body.module || !body.functionName) {
        return fail("agentId, reason, packageId, module, and functionName are required");
      }
      return ok(await getSdk().requestContractCallForAgent({
        taskId: body.taskId ?? randomUUID(),
        agentId: body.agentId,
        reason: body.reason,
        contractCall: {
          packageId: body.packageId,
          module: body.module,
          functionName: body.functionName,
          typeArguments: Array.isArray(body.typeArguments) ? body.typeArguments : [],
          arguments: Array.isArray(body.arguments) ? body.arguments : [],
          walletAddress: body.walletAddress,
        },
      }));
    },
  },
  {
    method: "POST",
    path: "/api/agent-runtime/x402",
    handler: async request => {
      const body = await readJson<{ url?: string; method?: string; body?: string; agentId?: string; taskId?: string; reason?: string }>(request);
      if (!body.url || !body.agentId || !body.reason) return fail("url, agentId and reason are required");
      return ok(await getSdk().requestHttpPaymentForAgent({
        url: body.url,
        method: body.method,
        body: body.body,
        agentId: body.agentId,
        taskId: body.taskId ?? randomUUID(),
        reason: body.reason,
      }));
    },
  },
  {
    method: "POST",
    path: "/api/x402/request",
    handler: async request => {
      const body = await readJson<{ url?: string; method?: string; body?: string; agentId?: string; taskId?: string; reason?: string; sessionKey?: string }>(request);
      if (!body.url || !body.agentId || !body.reason) return fail("url, agentId and reason are required");
      const opts = {
        url: body.url,
        method: body.method,
        body: body.body,
        agentId: body.agentId,
        taskId: body.taskId ?? randomUUID(),
        reason: body.reason,
      };
      return ok(body.sessionKey ? await getSdk().requestHttpPayment(opts, body.sessionKey) : await getSdk().requestHttpPaymentForAgent(opts));
    },
  },
  {
    method: "POST",
    path: "/api/x402/verify",
    handler: async request => {
      const body = await readJson<{ receiptHeader?: string; serviceId?: string }>(request);
      if (!body.receiptHeader || !body.serviceId) return fail("receiptHeader and serviceId are required");
      return ok(await getSdk().verifyIncomingPayment(body.receiptHeader, body.serviceId));
    },
  },
  {
    method: "POST",
    path: "/api/mock-agent/pay",
    handler: async request => {
      const body = await readJson<{
        agentId?: string;
        instruction?: string;
        coinType?: string;
        coinDecimals?: number;
        chatId?: string;
        walletAddress?: string;
        runtimeAgent?: RuntimeAgentSeed;
      }>(request);
      if (!body.agentId || !body.instruction) return fail("agentId and instruction are required");
      const coinDecimals =
        typeof body.coinDecimals === "number" && Number.isFinite(body.coinDecimals) && body.coinDecimals >= 0
          ? Math.floor(body.coinDecimals)
          : 9;
      const parsed = parseAgentInstruction(body.instruction, coinDecimals);
      const taskId = createTaskId();
      const sdk = getSdk();
      ensureRuntimeAgent(sdk, body.agentId, body.runtimeAgent);
      const status = sdk.getSystemStatus();
      const paymentResult =
        parsed.kind === "contract_call"
          ? await sdk.requestContractCallForAgent({
              taskId,
              agentId: body.agentId,
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
            ? await sdk.requestDeepBookSwapForAgent({
                taskId,
                agentId: body.agentId,
                reason: parsed.reason,
                deepbookSwap: buildDeepBookSwapMetadata({
                  network: status.network,
                  inputSymbol: parsed.inputSymbol,
                  outputSymbol: parsed.outputSymbol,
                  inputAmount: parsed.amount,
                  walletAddress: body.walletAddress,
                }),
              })
            : await sdk.requestPaymentForAgent({
                taskId,
                agentId: body.agentId,
                reason: parsed.reason,
                recipient: parsed.recipient,
                token: body.coinType ?? status.coinType,
                amount: parsed.amount,
              });
      const resolvedChatId =
        body.chatId?.trim() ||
        (body.walletAddress ? sdk.getTelegramBindingByWalletAddress(body.walletAddress)?.chatId ?? "" : "");
      const approvalRequest = (paymentResult as { approvalRequest?: { approvalToken: string } }).approvalRequest;
      let telegram: unknown;

      if (approvalRequest?.approvalToken) {
        telegram = resolvedChatId
          ? await sendTelegramApprovalRequest({
              approvalToken: approvalRequest.approvalToken,
              text:
                parsed.kind === "contract_call"
                  ? `Approval required for agent ${body.agentId}: call ${parsed.target}. Reason: ${parsed.reason}`
                  : parsed.kind === "deepbook_swap"
                    ? `Approval required for agent ${body.agentId}: swap ${parsed.amountInput} ${parsed.inputSymbol} to ${parsed.outputSymbol} via DeepBook. Reason: ${parsed.reason}`
                    : `Approval required for agent ${body.agentId}: ${parsed.amountInput} to ${parsed.recipient}. Reason: ${parsed.reason}`,
              chatId: resolvedChatId,
              walletAddress: body.walletAddress,
              state: {
                approval: approvalRequest,
                runtimeAgent: body.runtimeAgent,
              },
            })
          : { sent: false, error: "No Telegram chat ID was provided and no binding was found for the wallet address." };
      }

      return ok({
        agent: {
          mode: "tool-driven-demo",
          taskId,
          trace: buildDemoAgentTrace({ instruction: body.instruction, parsed, agentId: body.agentId }),
        },
        parsed,
        paymentResult,
        resolvedChatId,
        telegram,
      });
    },
  },
  {
    method: "GET",
    path: "/api/tg/approve",
    handler: async (request, url) => {
      const token = url.searchParams.get("token");
      const action = url.searchParams.get("action");
      if (!token || (action !== "approve" && action !== "reject")) return fail("token and action are required");

      const sdk = getSdk();
      const state = decodeApprovalState(url.searchParams.get("state"));
      const approval = sdk.getApprovalRequestByToken(token) ?? restoreStatelessApproval(sdk, token, state);
      if (!approval) throw new Error("Approval request not found");
      const data =
        action === "approve"
          ? await sdk.approvePaymentRequest(token, { requestedBy: "telegram-link" })
          : sdk.rejectPaymentRequest(token, { requestedBy: "telegram-link" });
      const approvalData = data as {
        status?: string;
        txHash?: string;
        approvalId?: string;
        agentId?: string;
        executionError?: string;
      };
      const status = approvalData.status ?? (action === "approve" ? "approved" : "rejected");
      const txLine = approvalData.txHash ? `\nTransaction: ${approvalData.txHash}` : "";
      const errorLine = approvalData.executionError ? `\nExecution error: ${approvalData.executionError}` : "";
      const summary = `Approval ${status} for agent ${approvalData.agentId ?? "unknown"}.\nApproval ID: ${approvalData.approvalId ?? "n/a"}${txLine}${errorLine}`;
      notifyTelegram(summary).catch(() => {});
      return wantsHtml(request)
        ? renderHtml(action === "approve" ? "Approval Processed" : "Request Rejected", summary, status === "executed" || status === "approved" ? "success" : "info")
        : ok(data);
    },
  },
  {
    method: "POST",
    path: "/api/tg/approve",
    handler: async request => {
      const body = await readJson<{ approvalToken?: string; text?: string; chatId?: string; walletAddress?: string }>(request);
      if (!body.approvalToken) return fail("approvalToken is required");
      return ok(await sendTelegramApprovalRequest({
        approvalToken: body.approvalToken,
        text: body.text,
        chatId: body.chatId,
        walletAddress: body.walletAddress,
      }));
    },
  },
];

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,x-agent-pay-key");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function authenticate(request: Request) {
  const apiKey = process.env.AGENT_PAY_API_KEY;
  if (!apiKey) return true;
  return request.headers.get("x-agent-pay-key") === apiKey;
}

export async function dispatch(request: Request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (!authenticate(request)) {
    return withCors(fail("Unauthorized", 401));
  }

  const route = routes.find(item => item.method === request.method && item.path === url.pathname);
  if (!route) {
    return withCors(fail("Route not found", 404, `${request.method} ${url.pathname}`));
  }

  try {
    return withCors(await route.handler(request, url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = isUserRuntimeError(message) ? 400 : 500;
    if (url.pathname === "/api/tg/approve" && wantsHtml(request)) {
      return withCors(renderHtml("Approval Failed", message, "error"));
    }
    return withCors(fail("Backend request failed", status, message));
  }
}

async function requestFromIncoming(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const host = req.headers.host ?? `127.0.0.1:${process.env.PORT ?? "8787"}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
  return new Request(url, {
    method,
    headers: req.headers as HeadersInit,
    body,
  });
}

async function writeResponse(res: http.ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

export async function handleNodeRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    await writeResponse(res, await dispatch(await requestFromIncoming(req)));
  } catch (error) {
    await writeResponse(res, withCors(fail("Unhandled backend error", 500, error instanceof Error ? error.message : String(error))));
  }
}

export function startServer(port = Number(process.env.PORT || 8787)) {
  const server = http.createServer(handleNodeRequest);
  server.listen(port, () => {
    console.log(`sui-agent-pay backend listening on http://127.0.0.1:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

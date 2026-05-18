import { createHash, randomUUID } from "crypto";

import type {
  AgentConfig,
  AgentIdentityInfo,
  AgentPolicy,
  AgentType,
  AggregatedDecision,
  AppConfig,
  PaymentIntent,
  PaymentResult,
  PaidService,
  ReputationAssessment,
  SessionKeyInfo,
  X402HttpRequestOptions,
  X402HttpResult,
  InterAgentSettlementResult,
  ApprovalRequest,
  TelegramBinding,
} from "./types";
import {
  AGENT_TEMPLATES,
  DEFAULT_COIN_TYPE,
} from "./types";
import { PolicyEngine } from "./core/policy-engine";
import { AiRiskEvaluator } from "./core/ai-risk-evaluator";
import { DecisionAggregator } from "./core/decision-aggregator";
import { AuditLogger } from "./core/audit-logger";
import { SuiChainClient } from "./chain/sui-client";
import { Storage } from "./storage/sqlite";
import { callPaidService } from "./settlement/inter-agent";
import { build402Response, verifyPaymentOnChain, parsePaymentReceipt } from "./x402/x402-server";
import { makeHttpRequest, parsePaymentRequired, toPaymentIntent, retryWithReceipt } from "./x402/x402-client";
import { generateSuiSessionKey, resolveSuiAddress } from "./sui-keys";
import { assertCoinType, assertSafeHttpUrl, assertSuiAddress, parsePositiveU64 } from "./validation";

function unwrapTransaction(raw: unknown): any {
  if (!raw || typeof raw !== "object") return null;
  if ("$kind" in raw && raw.$kind === "Transaction" && "Transaction" in raw) {
    return (raw as any).Transaction;
  }
  if ("$kind" in raw && raw.$kind === "FailedTransaction" && "FailedTransaction" in raw) {
    return (raw as any).FailedTransaction;
  }
  return raw;
}

function getEventJson(raw: unknown, module: string, eventPrefix: string): Record<string, unknown> | null {
  const tx = unwrapTransaction(raw);
  const events = Array.isArray(tx?.events) ? tx.events : [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.module !== module) continue;
    if (typeof event.eventType !== "string" || !event.eventType.includes(`::${eventPrefix}`)) continue;
    if (event.json && typeof event.json === "object") {
      return event.json as Record<string, unknown>;
    }
  }
  return null;
}

function parseGasUsed(raw: unknown): string | undefined {
  const tx = unwrapTransaction(raw);
  const gasSummary = tx?.effects?.gasUsed;
  if (!gasSummary || typeof gasSummary !== "object") return undefined;

  const computation = BigInt(gasSummary.computationCost ?? 0);
  const storage = BigInt(gasSummary.storageCost ?? 0);
  const rebate = BigInt(gasSummary.storageRebate ?? 0);
  return (computation + storage - rebate).toString();
}

function translateVaultExecutePaymentError(
  error: unknown,
  context: {
    vaultId: string;
    sessionKey: string;
    recipient: string;
    amount: string;
  }
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Unable to perform gas selection due to insufficient SUI balance")) {
    return `Session key ${context.sessionKey} does not have enough SUI to pay gas. Fund the session key address with a small amount of SUI, then retry the payment.`;
  }

  if (!message.includes("agent_vault::execute_payment")) {
    return message;
  }

  if (message.includes("abort code: 4")) {
    return `Session key is not registered on-chain for this vault. Register ${context.sessionKey} on vault ${context.vaultId}, then sync the same key into the runtime.`;
  }

  if (message.includes("abort code: 5")) {
    return `Session key ${context.sessionKey} has been revoked on-chain for vault ${context.vaultId}.`;
  }

  if (message.includes("abort code: 6")) {
    return `Session key ${context.sessionKey} is expired on-chain for vault ${context.vaultId}.`;
  }

  if (message.includes("abort code: 7")) {
    return `Payment amount ${context.amount} exceeds the on-chain per-transaction limit for session key ${context.sessionKey}.`;
  }

  if (message.includes("abort code: 8")) {
    return `Payment amount ${context.amount} exceeds the remaining on-chain session budget for session key ${context.sessionKey}.`;
  }

  if (message.includes("abort code: 9")) {
    return `Recipient ${context.recipient} is not allowed by the on-chain session policy for ${context.sessionKey}.`;
  }

  if (message.includes("abort code: 2")) {
    return `Vault ${context.vaultId} is paused on-chain.`;
  }

  return message;
}

function createApprovalToken() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function validatePolicyForRegistration(policy: AgentPolicy, sessionKey: string, vaultId: string, coinType: string): void {
  assertSuiAddress(sessionKey, "sessionKey");
  assertSuiAddress(vaultId, "vaultId");
  assertCoinType(coinType);

  const maxPerTx = parsePositiveU64(policy.maxPerTx, "maxPerTx");
  const maxTotal = parsePositiveU64(policy.maxTotal, "maxTotal");
  parsePositiveU64(policy.dailyBudget, "dailyBudget");
  parsePositiveU64(policy.weeklyBudget, "weeklyBudget");
  parsePositiveU64(policy.approvalThreshold, "approvalThreshold");

  if (maxPerTx > maxTotal) {
    throw new Error("maxPerTx cannot exceed maxTotal");
  }

  for (const recipient of policy.allowedRecipients) {
    assertSuiAddress(recipient, "allowedRecipients[]");
  }

  for (const token of policy.allowedTokens) {
    assertCoinType(token, "allowedTokens[]");
  }

  if (!Number.isFinite(policy.validUntil) || policy.validUntil <= Math.floor(Date.now() / 1000)) {
    throw new Error("validUntil must be in the future");
  }
}

export class AgentPaySDK {
  private policyEngine: PolicyEngine;
  private aiRisk: AiRiskEvaluator;
  private aggregator: DecisionAggregator;
  private auditLogger: AuditLogger;
  private chain: SuiChainClient;
  private storage: Storage;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = {
      ...config,
      coinType: config.coinType ?? DEFAULT_COIN_TYPE,
    };
    this.policyEngine = new PolicyEngine();
    this.aiRisk = new AiRiskEvaluator();
    this.aggregator = new DecisionAggregator();
    this.auditLogger = new AuditLogger();
    this.chain = new SuiChainClient(this.config);
    this.storage = new Storage(config.dbPath);
  }

  async getWalletAddress(secretKey: string): Promise<string> {
    return resolveSuiAddress(secretKey);
  }

  async getWalletBalance(address: string, coinType = this.config.coinType ?? DEFAULT_COIN_TYPE) {
    return this.chain.getBalance(address, coinType);
  }

  async createVault(ownerSecretKey: string, coinType = this.config.coinType ?? DEFAULT_COIN_TYPE) {
    const result = await this.chain.createVault({
      signerSecretKey: ownerSecretKey,
      coinType,
    });

    const eventJson = getEventJson(result.rawResponse, this.config.move.vaultModule, "VaultCreated");
    const vaultId = typeof eventJson?.vault_id === "string" ? eventJson.vault_id : undefined;

    if (vaultId) {
      this.config.vaultId = vaultId;
    }

    return {
      vaultId,
      txHash: result.digest,
      rawResponse: result.rawResponse,
    };
  }

  async createRegistry(ownerSecretKey: string) {
    const result = await this.chain.createRegistry({
      signerSecretKey: ownerSecretKey,
    });

    const tx = unwrapTransaction(result.rawResponse);
    const objectType = `${this.config.move.packageId}::${this.config.move.registryModule}::AgentRegistry`;
    const createdObject = Array.isArray(tx?.effects?.changedObjects)
      ? tx.effects.changedObjects.find((entry: any) => entry?.objectType === objectType)
      : null;
    const registryId = createdObject?.objectId;

    if (typeof registryId === "string") {
      this.config.registryId = registryId;
    }

    return {
      registryId,
      txHash: result.digest,
      rawResponse: result.rawResponse,
    };
  }

  async createAgent(params: {
    label: string;
    agentType: AgentType;
    userId: string;
    ownerSecretKey: string;
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
    }>;
  }): Promise<{ agent: AgentConfig; policy: AgentPolicy; sessionKeyPrivate: string }> {
    const vaultId = params.vaultId ?? this.config.vaultId;
    if (!vaultId) throw new Error("vaultId is required to create an agent");
    assertSuiAddress(vaultId, "vaultId");

    const coinType = params.coinType ?? params.allowedTokens?.[0] ?? this.config.coinType ?? DEFAULT_COIN_TYPE;
    assertCoinType(coinType);
    const template = AGENT_TEMPLATES[params.agentType];
    const session = await generateSuiSessionKey();

    const agentId = randomUUID();
    const policyId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const validity = params.overrides?.validity ?? template.validity;
    const expiry = now + validity;

    const policy: AgentPolicy = {
      policyId,
      agentId,
      maxPerTx: params.overrides?.maxPerTx ?? template.maxPerTx,
      maxTotal: params.overrides?.maxTotal ?? template.maxTotal,
      dailyBudget: params.overrides?.dailyBudget ?? template.dailyBudget,
      weeklyBudget: params.overrides?.weeklyBudget ?? template.weeklyBudget,
      allowedRecipients: params.allowedRecipients ?? [],
      allowedTokens: params.allowedTokens ?? [coinType],
      allowedMethods: [],
      approvalThreshold: template.approvalThreshold,
      taskBinding: template.taskBinding,
      retryPolicy: { ...template.retryPolicy },
      validUntil: expiry,
    };

    validatePolicyForRegistration(policy, session.address, vaultId, coinType);

    const allowedRecipient = policy.allowedRecipients.length === 1
      ? policy.allowedRecipients[0]
      : "0x0";

    await this.chain.registerSessionKey({
      signerSecretKey: params.ownerSecretKey,
      vaultId,
      sessionKeyAddress: session.address,
      maxPerTx: BigInt(policy.maxPerTx),
      maxTotal: BigInt(policy.maxTotal),
      expiryMs: BigInt(expiry) * 1000n,
      allowedRecipient,
      coinType,
    });

    const agent: AgentConfig = {
      agentId,
      label: params.label,
      agentType: params.agentType,
      userId: params.userId,
      sessionKey: session.address,
      vaultId,
      coinType,
      createdAt: new Date().toISOString(),
    };

    this.storage.saveAgent(agent);
    this.storage.savePolicy(policy);

    return {
      agent,
      policy,
      sessionKeyPrivate: session.secretKey,
    };
  }

  registerLocalAgent(params: {
    label: string;
    agentType: AgentType;
    userId: string;
    sessionKey: string;
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
  }): { agent: AgentConfig; policy: AgentPolicy } {
    const vaultId = params.vaultId ?? this.config.vaultId;
    if (!vaultId) throw new Error("vaultId is required to register a local agent");
    assertSuiAddress(vaultId, "vaultId");

    const coinType = params.coinType ?? params.allowedTokens?.[0] ?? this.config.coinType ?? DEFAULT_COIN_TYPE;
    assertCoinType(coinType);
    const template = AGENT_TEMPLATES[params.agentType];
    const now = Math.floor(Date.now() / 1000);
    const validity = params.overrides?.validity ?? template.validity;
    const expiry = now + validity;

    const agent: AgentConfig = {
      agentId: params.agentId ?? randomUUID(),
      label: params.label,
      agentType: params.agentType,
      userId: params.userId,
      sessionKey: params.sessionKey,
      sessionKeyPrivate: params.sessionKeyPrivate,
      vaultId,
      coinType,
      createdAt: params.createdAt ?? new Date().toISOString(),
    };

    const policy: AgentPolicy = {
      policyId: params.policyId ?? randomUUID(),
      agentId: agent.agentId,
      maxPerTx: params.overrides?.maxPerTx ?? template.maxPerTx,
      maxTotal: params.overrides?.maxTotal ?? template.maxTotal,
      dailyBudget: params.overrides?.dailyBudget ?? template.dailyBudget,
      weeklyBudget: params.overrides?.weeklyBudget ?? template.weeklyBudget,
      allowedRecipients: params.allowedRecipients ?? [],
      allowedTokens: params.allowedTokens ?? [coinType],
      allowedMethods: [],
      approvalThreshold: params.overrides?.approvalThreshold ?? template.approvalThreshold,
      taskBinding: template.taskBinding,
      retryPolicy: { ...template.retryPolicy },
      validUntil: expiry,
    };

    validatePolicyForRegistration(policy, agent.sessionKey, vaultId, coinType);

    this.storage.saveAgent(agent);
    this.storage.savePolicy(policy);

    return { agent, policy };
  }

  private async executeApprovedPayment(
    intent: PaymentIntent,
    sessionKeyPrivate: string,
    options?: { humanApproved?: boolean }
  ): Promise<PaymentResult> {
    const agent = this.storage.getAgent(intent.agentId);
    if (!agent) throw new Error(`Agent not found: ${intent.agentId}`);
    if (agent.revokedAt) throw new Error(`Agent session key is revoked: ${intent.agentId}`);
    assertSuiAddress(agent.vaultId, "agent.vaultId");
    assertSuiAddress(agent.sessionKey, "agent.sessionKey");
    assertSuiAddress(intent.recipient, "recipient");
    assertCoinType(intent.token, "token");
    parsePositiveU64(intent.amount, "amount");

    const policy = this.storage.getPolicy(intent.agentId);
    if (!policy) throw new Error(`Policy not found for agent: ${intent.agentId}`);
    validatePolicyForRegistration(policy, agent.sessionKey, agent.vaultId, agent.coinType);

    const signerAddress = await resolveSuiAddress(sessionKeyPrivate);
    if (signerAddress.toLowerCase() !== agent.sessionKey.toLowerCase()) {
      throw new Error("sessionKeyPrivate does not match the selected agent session key");
    }

    const budget = this.storage.getDailyBudget(intent.agentId);
    const recentReceipts = this.storage.getReceipts(intent.agentId, 50);
    this.aiRisk.loadHistory(recentReceipts);

    const hardResult = this.policyEngine.evaluate(intent, policy, budget);

    let aggregated: AggregatedDecision;
    if (!hardResult.passed) {
      aggregated = this.aggregator.aggregate(hardResult, {
        score: 0,
        level: "low",
        reasons: ["skipped_hard_deny"],
        modelVersion: "skipped",
      });
    } else {
      try {
        const aiResult = await this.aiRisk.evaluate(intent);
        aggregated = this.aggregator.aggregate(hardResult, aiResult);
      } catch {
        aggregated = this.aggregator.aggregateWithoutAi(
          hardResult,
          BigInt(policy.approvalThreshold),
          BigInt(intent.amount)
        );
      }
    }

    let txHash: string | undefined;
    let gasUsed: string | undefined;
    let result: "success" | "failed" | "rejected" | "pending";
    let error: string | undefined;

    if (aggregated.decision === "allow" || options?.humanApproved) {
      if (intent.token !== agent.coinType) {
        result = "failed";
        error = `Agent coin type mismatch: expected ${agent.coinType}, got ${intent.token}`;
      } else {
        try {
          const chainResult = await this.chain.executePayment({
            signerSecretKey: sessionKeyPrivate,
            vaultId: agent.vaultId,
            recipient: intent.recipient,
            amount: BigInt(intent.amount),
            coinType: agent.coinType,
          });
          txHash = chainResult.digest;
          gasUsed = parseGasUsed(chainResult.rawResponse);
          result = "success";
          this.storage.incrementDailyBudget(intent.agentId, intent.amount);
        } catch (err: any) {
          result = "failed";
          error = translateVaultExecutePaymentError(err, {
            vaultId: agent.vaultId,
            sessionKey: agent.sessionKey,
            recipient: intent.recipient,
            amount: intent.amount,
          });
        }
      }
    } else if (aggregated.decision === "require_approval") {
      result = "pending";
    } else {
      result = "rejected";
    }

    const receipt = this.auditLogger.createReceipt(intent, aggregated, {
      userId: agent.userId,
      agentType: agent.agentType,
      humanApproved: !!options?.humanApproved,
      signerType: "sui_session_key",
      txHash,
      result,
      gasUsed,
    });
    this.storage.saveReceipt(receipt);

    return {
      paymentId: receipt.paymentId,
      decision: aggregated.decision,
      result,
      txHash,
      receipt,
      error,
    };
  }

  async requestPayment(
    intent: PaymentIntent,
    sessionKeyPrivate: string
  ): Promise<PaymentResult> {
    const execution = await this.executeApprovedPayment(intent, sessionKeyPrivate);

    if (execution.decision === "require_approval") {
      const approvalRequest: ApprovalRequest = {
        approvalId: randomUUID(),
        approvalToken: createApprovalToken(),
        agentId: intent.agentId,
        taskId: intent.taskId,
        reason: intent.reason,
        recipient: intent.recipient,
        token: intent.token,
        amount: intent.amount,
        status: "pending",
        channel: "telegram",
        sourcePaymentId: execution.paymentId,
        createdAt: new Date().toISOString(),
      };
      this.storage.saveApprovalRequest(approvalRequest);
      return {
        ...execution,
        approvalRequest,
      };
    }

    return execution;
  }

  listApprovalRequests(limit?: number) {
    return this.storage.listApprovalRequests(limit);
  }

  getApprovalRequestByToken(token: string) {
    return this.storage.getApprovalRequestByToken(token);
  }

  async approvePaymentRequest(
    approvalToken: string,
    options?: { note?: string; requestedBy?: string }
  ) {
    const approval = this.storage.getApprovalRequestByToken(approvalToken);
    if (!approval) {
      throw new Error("Approval request not found");
    }

    if (approval.status !== "pending") {
      return approval;
    }

    const agent = this.storage.getAgent(approval.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${approval.agentId}`);
    }
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${approval.agentId}`);
    }

    const execution = await this.executeApprovedPayment(
      {
        taskId: approval.taskId,
        agentId: approval.agentId,
        reason: approval.reason,
        recipient: approval.recipient,
        token: approval.token,
        amount: approval.amount,
      },
      agent.sessionKeyPrivate,
      { humanApproved: true }
    );

    const nextStatus = execution.result === "success" ? "executed" : "failed";

    return this.storage.updateApprovalRequest(approval.approvalId, {
      status: nextStatus,
      resolvedAt: new Date().toISOString(),
      approvalNote: options?.note,
      requestedBy: options?.requestedBy,
      txHash: execution.txHash,
      executionPaymentId: execution.paymentId,
    });
  }

  rejectPaymentRequest(
    approvalToken: string,
    options?: { note?: string; requestedBy?: string }
  ) {
    const approval = this.storage.getApprovalRequestByToken(approvalToken);
    if (!approval) {
      throw new Error("Approval request not found");
    }

    if (approval.status !== "pending") {
      return approval;
    }

    return this.storage.updateApprovalRequest(approval.approvalId, {
      status: "rejected",
      resolvedAt: new Date().toISOString(),
      approvalNote: options?.note,
      requestedBy: options?.requestedBy,
    });
  }

  async requestPaymentForAgent(
    intent: PaymentIntent
  ): Promise<PaymentResult> {
    const agent = this.storage.getAgent(intent.agentId);
    if (!agent) throw new Error(`Agent not found: ${intent.agentId}`);
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${intent.agentId}`);
    }

    return this.requestPayment(intent, agent.sessionKeyPrivate);
  }

  async revokeKey(agentId: string, ownerSecretKey: string): Promise<void> {
    const agent = this.storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    await this.chain.revokeSessionKey({
      signerSecretKey: ownerSecretKey,
      vaultId: agent.vaultId,
      sessionKeyAddress: agent.sessionKey,
      coinType: agent.coinType,
    });
    this.storage.markAgentRevoked(agentId, new Date().toISOString());
  }

  getSessionInfo(agentId: string): SessionKeyInfo {
    const agent = this.storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const policy = this.storage.getPolicy(agentId);
    if (!policy) throw new Error(`Policy not found for agent: ${agentId}`);

    const successfulReceipts = this.storage
      .getReceipts(agentId, 500)
      .filter((receipt) => receipt.result === "success");
    const spent = successfulReceipts
      .reduce((sum, receipt) => sum + BigInt(receipt.amount), 0n)
      .toString();

    return {
      address: agent.sessionKey,
      maxPerTx: policy.maxPerTx,
      maxTotal: policy.maxTotal,
      spent,
      expiry: policy.validUntil,
      allowedRecipient: policy.allowedRecipients.length === 1 ? policy.allowedRecipients[0] : "0x0",
      allowedToken: agent.coinType,
      exists: true,
      revoked: !!agent.revokedAt,
    };
  }

  async deposit(ownerSecretKey: string, coinObjectId: string, vaultId?: string, coinType?: string) {
    assertSuiAddress(vaultId ?? this.config.vaultId ?? "", "vaultId");
    assertSuiAddress(coinObjectId, "coinObjectId");
    const result = await this.chain.deposit({
      signerSecretKey: ownerSecretKey,
      vaultId: vaultId ?? this.config.vaultId ?? "",
      coinObjectId,
      coinType: coinType ?? this.config.coinType ?? DEFAULT_COIN_TYPE,
    });
    return result;
  }

  async withdraw(ownerSecretKey: string, amount: bigint, recipient?: string, vaultId?: string, coinType?: string) {
    assertSuiAddress(vaultId ?? this.config.vaultId ?? "", "vaultId");
    parsePositiveU64(amount, "amount");
    if (recipient) assertSuiAddress(recipient, "recipient");
    const result = await this.chain.withdraw({
      signerSecretKey: ownerSecretKey,
      vaultId: vaultId ?? this.config.vaultId ?? "",
      amount,
      recipient,
      coinType: coinType ?? this.config.coinType ?? DEFAULT_COIN_TYPE,
    });
    return result;
  }

  async emergencyPause(ownerSecretKey: string, vaultId?: string, coinType?: string) {
    assertSuiAddress(vaultId ?? this.config.vaultId ?? "", "vaultId");
    return this.chain.setPaused({
      signerSecretKey: ownerSecretKey,
      vaultId: vaultId ?? this.config.vaultId ?? "",
      paused: true,
      coinType: coinType ?? this.config.coinType ?? DEFAULT_COIN_TYPE,
    });
  }

  async unpause(ownerSecretKey: string, vaultId?: string, coinType?: string) {
    assertSuiAddress(vaultId ?? this.config.vaultId ?? "", "vaultId");
    return this.chain.setPaused({
      signerSecretKey: ownerSecretKey,
      vaultId: vaultId ?? this.config.vaultId ?? "",
      paused: false,
      coinType: coinType ?? this.config.coinType ?? DEFAULT_COIN_TYPE,
    });
  }

  async requestHttpPayment(
    opts: X402HttpRequestOptions,
    sessionKeyPrivate: string
  ): Promise<X402HttpResult> {
    assertSafeHttpUrl(opts.url);
    const initial = await makeHttpRequest(opts);

    if (initial.status !== 402) {
      return {
        httpStatus: initial.status,
        responseBody: initial.body,
        responseHeaders: initial.headers,
        paid: false,
      };
    }

    const paymentHeader =
      initial.headers["payment-required"] ??
      initial.headers["x-payment-required"];

    if (!paymentHeader) {
      return {
        httpStatus: 402,
        responseBody: initial.body,
        responseHeaders: initial.headers,
        paid: false,
      };
    }

    const requirements = parsePaymentRequired(paymentHeader);
    if (requirements.network !== this.config.network) {
      return {
        httpStatus: 402,
        responseBody: JSON.stringify({
          error: "Payment network mismatch",
          expected: this.config.network,
          actual: requirements.network,
        }),
        responseHeaders: initial.headers,
        paid: false,
      };
    }
    if (requirements.scheme !== "exact") {
      return {
        httpStatus: 402,
        responseBody: JSON.stringify({
          error: "Unsupported payment scheme",
          scheme: requirements.scheme,
        }),
        responseHeaders: initial.headers,
        paid: false,
      };
    }
    const intent = toPaymentIntent(requirements, opts);
    const paymentResult = await this.requestPayment(intent, sessionKeyPrivate);

    if (paymentResult.result !== "success" || !paymentResult.txHash) {
      return {
        httpStatus: 402,
        responseBody: JSON.stringify({
          error: "Payment not approved",
          decision: paymentResult.decision,
          result: paymentResult.result,
        }),
        responseHeaders: initial.headers,
        paymentResult,
        paid: false,
      };
    }

    const retry = await retryWithReceipt(opts, paymentResult.txHash, this.config.network);

    return {
      httpStatus: retry.status,
      responseBody: retry.body,
      responseHeaders: retry.headers,
      paymentResult,
      paid: true,
    };
  }

  async requestHttpPaymentForAgent(
    opts: X402HttpRequestOptions
  ): Promise<X402HttpResult> {
    const agent = this.storage.getAgent(opts.agentId);
    if (!agent) throw new Error(`Agent not found: ${opts.agentId}`);
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${opts.agentId}`);
    }

    return this.requestHttpPayment(opts, agent.sessionKeyPrivate);
  }

  async callPaidAgent(
    opts: X402HttpRequestOptions,
    sessionKeyPrivate: string
  ): Promise<InterAgentSettlementResult> {
    return callPaidService(opts, sessionKeyPrivate, {
      requestPayment: (intent, key) => this.requestPayment(intent, key),
    });
  }

  registerPaidService(service: PaidService): void {
    assertSafeHttpUrl(service.url);
    assertSuiAddress(service.payToAddress, "payToAddress");
    assertCoinType(service.priceToken, "priceToken");
    parsePositiveU64(service.priceAmount, "priceAmount");
    this.storage.saveService(service);
  }

  listPaidServices(): PaidService[] {
    return this.storage.listServices();
  }

  removePaidService(serviceId: string): boolean {
    return this.storage.deleteService(serviceId);
  }

  upsertTelegramBinding(walletAddress: string, chatId: string): TelegramBinding {
    assertSuiAddress(walletAddress, "walletAddress");
    if (!chatId.trim()) {
      throw new Error("chatId is required");
    }

    const existing = this.storage.getTelegramBindingByWalletAddress(walletAddress);
    const now = new Date().toISOString();
    const binding: TelegramBinding = {
      bindingId: existing?.bindingId ?? randomUUID(),
      walletAddress: walletAddress.toLowerCase(),
      chatId: chatId.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.storage.saveTelegramBinding(binding);
    return binding;
  }

  getTelegramBindingByWalletAddress(walletAddress: string): TelegramBinding | null {
    assertSuiAddress(walletAddress, "walletAddress");
    return this.storage.getTelegramBindingByWalletAddress(walletAddress);
  }

  listTelegramBindings(): TelegramBinding[] {
    return this.storage.listTelegramBindings();
  }

  removeTelegramBinding(walletAddress: string): boolean {
    assertSuiAddress(walletAddress, "walletAddress");
    return this.storage.deleteTelegramBinding(walletAddress);
  }

  buildPaymentRequired(serviceId: string): { status: 402; headers: Record<string, string>; body: string } | null {
    const service = this.storage.getService(serviceId);
    if (!service) return null;
    return build402Response(service);
  }

  async verifyIncomingPayment(
    receiptHeader: string,
    serviceId: string
  ): Promise<{ verified: boolean; reason?: string }> {
    const service = this.storage.getService(serviceId);
    if (!service) return { verified: false, reason: "Service not found" };

    const receipt = parsePaymentReceipt(receiptHeader);
    if (!receipt) return { verified: false, reason: "Invalid receipt header" };
    if (receipt.network && receipt.network !== service.network) {
      return { verified: false, reason: "Receipt network does not match service network" };
    }

    return verifyPaymentOnChain(
      this.config.fullnodeUrl,
      receipt.txHash,
      service.payToAddress,
      service.priceToken,
      service.priceAmount
    );
  }

  async registerOnChainAgent(
    ownerSecretKey: string,
    agentURI: string,
    wallet?: string,
    registryId?: string
  ): Promise<{ txHash: string; agentId?: number }> {
    const activeRegistryId = registryId ?? this.config.registryId;
    if (!activeRegistryId) throw new Error("registryId is not configured");
    assertSuiAddress(activeRegistryId, "registryId");
    if (wallet) assertSuiAddress(wallet, "wallet");

    const result = await this.chain.registerAgent({
      signerSecretKey: ownerSecretKey,
      registryId: activeRegistryId,
      agentUri: agentURI,
      paymentAddress: wallet,
    });

    const eventJson = getEventJson(result.rawResponse, this.config.move.registryModule, "AgentRegistered");
    const agentId = eventJson?.agent_id;

    return {
      txHash: result.digest,
      agentId: typeof agentId === "number" ? agentId : typeof agentId === "string" ? Number(agentId) : undefined,
    };
  }

  async giveFeedback(
    signerSecretKey: string,
    agentId: number,
    value: number,
    registryId?: string
  ): Promise<{ txHash: string }> {
    const activeRegistryId = registryId ?? this.config.registryId;
    if (!activeRegistryId) throw new Error("registryId is not configured");
    assertSuiAddress(activeRegistryId, "registryId");
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error("feedback value must be an integer from 0 to 100");
    }

    const result = await this.chain.giveFeedback({
      signerSecretKey,
      registryId: activeRegistryId,
      agentId,
      score: value,
    });
    return { txHash: result.digest };
  }

  async checkReputationByWallet(_wallet: string): Promise<ReputationAssessment> {
    return {
      registered: false,
      riskLevel: "UNKNOWN",
      avgScore: -1,
    };
  }

  async checkReputation(_agentId: number): Promise<ReputationAssessment> {
    return {
      registered: false,
      riskLevel: "UNKNOWN",
      avgScore: -1,
    };
  }

  listAgents() {
    return this.storage.listAgents();
  }

  getAuditLog(agentId: string, limit?: number) {
    return this.storage.getReceipts(agentId, limit);
  }

  getRecentAuditLog(limit?: number) {
    return this.storage.getRecentReceipts(limit);
  }

  getSystemStatus() {
    const agents = this.storage.listAgents();
    const receipts = this.storage.getRecentReceipts(20);
    const services = this.storage.listServices();

    return {
      network: this.config.network,
      fullnodeUrl: this.config.fullnodeUrl,
      ownerAddress: this.config.ownerAddress,
      dbPath: this.config.dbPath,
      storageMode: this.storage.storageMode,
      vaultId: this.config.vaultId ?? "",
      registryId: this.config.registryId ?? "",
      coinType: this.config.coinType ?? DEFAULT_COIN_TYPE,
      move: { ...this.config.move },
      counts: {
        agents: agents.length,
        recentReceipts: receipts.length,
        paidServices: services.length,
      },
    };
  }

  close() {
    this.storage.close();
  }
}

export * from "./types";
export * from "./sui-types";
export { generateSuiSessionKey, resolveSuiAddress } from "./sui-keys";
export { PolicyEngine } from "./core/policy-engine";
export { AiRiskEvaluator } from "./core/ai-risk-evaluator";
export { DecisionAggregator } from "./core/decision-aggregator";
export { AuditLogger } from "./core/audit-logger";
export { SuiChainClient } from "./chain/sui-client";
export { Storage } from "./storage/sqlite";
export { parsePaymentRequired, toPaymentIntent, makeHttpRequest, retryWithReceipt } from "./x402/x402-client";
export { build402Response, createPaymentRequiredHeader, verifyPaymentOnChain, parsePaymentReceipt } from "./x402/x402-server";
export { callPaidService } from "./settlement/inter-agent";

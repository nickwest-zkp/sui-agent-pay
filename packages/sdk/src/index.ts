import { createHash, randomUUID } from "crypto";

import type {
  AgentConfig,
  AgentIdentityInfo,
  AgentPolicy,
  AgentType,
  AggregatedDecision,
  AppConfig,
  ContractCallArgument,
  ContractCallIntent,
  ContractCallMetadata,
  ContractWhitelistEntry,
  DeepBookRouteDirection,
  DeepBookRouteHop,
  DeepBookSwapIntent,
  DeepBookSwapMetadata,
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
import { assertCoinType, assertMoveIdentifier, assertSafeHttpUrl, assertSuiAddress, parsePositiveU64, parseU64 } from "./validation";

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

function buildContractCallTarget(metadata: Pick<ContractCallMetadata, "packageId" | "module" | "functionName">): string {
  return `${metadata.packageId}::${metadata.module}::${metadata.functionName}`;
}

function translateMoveCallExecutionError(
  error: unknown,
  context: {
    sessionKey: string;
    target: string;
  }
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Unable to perform gas selection due to insufficient SUI balance")) {
    return `Session key ${context.sessionKey} does not have enough SUI to pay gas for ${context.target}. Fund the session key address with a small amount of SUI, then retry the contract call.`;
  }

  return message;
}

function translateDeepBookExecutionError(
  error: unknown,
  context: {
    sessionKey: string;
    packageId: string;
    inputAmount: string;
    inputCoinType: string;
    outputCoinType: string;
  }
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Unable to perform gas selection due to insufficient SUI balance")) {
    return `Session key ${context.sessionKey} does not have enough SUI to pay gas for the DeepBook swap. Fund the session key address with a small amount of SUI, then retry.`;
  }

  return `DeepBook swap ${context.inputAmount} ${context.inputCoinType} -> ${context.outputCoinType} via package ${context.packageId} failed: ${message}`;
}

function createApprovalToken() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function normalizeContractCallArgument(arg: ContractCallArgument, index: number): ContractCallArgument {
  if (!arg || typeof arg !== "object") {
    throw new Error(`contractCall.arguments[${index}] must be an object`);
  }

  switch (arg.kind) {
    case "object":
    case "address":
      assertSuiAddress(String(arg.value), `contractCall.arguments[${index}].value`);
      return { kind: arg.kind, value: String(arg.value) };
    case "u64":
      return { kind: arg.kind, value: parseU64(String(arg.value), `contractCall.arguments[${index}].value`, { allowZero: true }).toString() };
    case "string":
      if (typeof arg.value !== "string") {
        throw new Error(`contractCall.arguments[${index}].value must be a string`);
      }
      return { kind: arg.kind, value: arg.value };
    case "bool":
      if (typeof arg.value === "boolean") {
        return { kind: arg.kind, value: arg.value };
      }
      if (typeof arg.value === "string" && /^(true|false)$/i.test(arg.value)) {
        return { kind: arg.kind, value: arg.value.toLowerCase() === "true" };
      }
      throw new Error(`contractCall.arguments[${index}].value must be true or false`);
    default:
      throw new Error(`Unsupported contractCall argument kind: ${(arg as ContractCallArgument).kind}`);
  }
}

function normalizeContractCallMetadata(metadata: ContractCallMetadata): ContractCallMetadata {
  assertSuiAddress(metadata.packageId, "contractCall.packageId");
  assertMoveIdentifier(metadata.module, "contractCall.module");
  assertMoveIdentifier(metadata.functionName, "contractCall.functionName");
  if (metadata.walletAddress) {
    assertSuiAddress(metadata.walletAddress, "contractCall.walletAddress");
  }

  const typeArguments = Array.isArray(metadata.typeArguments)
    ? metadata.typeArguments.map((value, index) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`contractCall.typeArguments[${index}] must be a non-empty string`);
        }
        return value.trim();
      })
    : [];

  const argumentsList = Array.isArray(metadata.arguments)
    ? metadata.arguments.map((arg, index) => normalizeContractCallArgument(arg, index))
    : [];
  const normalizedPackageId = metadata.packageId.toLowerCase();

  return {
    packageId: normalizedPackageId,
    module: metadata.module,
    functionName: metadata.functionName,
    target: buildContractCallTarget({
      packageId: normalizedPackageId,
      module: metadata.module,
      functionName: metadata.functionName,
    }),
    typeArguments,
    arguments: argumentsList,
    walletAddress: metadata.walletAddress?.toLowerCase(),
  };
}

function normalizeDeepBookDirection(
  direction: DeepBookRouteDirection,
  fieldName: string
): DeepBookRouteDirection {
  if (direction !== "base_to_quote" && direction !== "quote_to_base") {
    throw new Error(`${fieldName} must be "base_to_quote" or "quote_to_base"`);
  }
  return direction;
}

function normalizeDeepBookRouteHop(hop: DeepBookRouteHop, index: number): DeepBookRouteHop {
  assertSuiAddress(hop.poolId, `deepbookSwap.route[${index}].poolId`);
  assertCoinType(hop.baseCoinType, `deepbookSwap.route[${index}].baseCoinType`);
  assertCoinType(hop.quoteCoinType, `deepbookSwap.route[${index}].quoteCoinType`);

  return {
    poolId: hop.poolId.toLowerCase(),
    baseCoinType: hop.baseCoinType,
    quoteCoinType: hop.quoteCoinType,
    direction: normalizeDeepBookDirection(hop.direction, `deepbookSwap.route[${index}].direction`),
    minOutputAmount: parseU64(
      hop.minOutputAmount,
      `deepbookSwap.route[${index}].minOutputAmount`,
      { allowZero: true }
    ).toString(),
  };
}

function normalizeDeepBookSwapMetadata(metadata: DeepBookSwapMetadata): DeepBookSwapMetadata {
  assertSuiAddress(metadata.packageId, "deepbookSwap.packageId");
  assertCoinType(metadata.inputCoinType, "deepbookSwap.inputCoinType");
  assertCoinType(metadata.outputCoinType, "deepbookSwap.outputCoinType");
  assertCoinType(metadata.deepCoinType, "deepbookSwap.deepCoinType");
  if (metadata.walletAddress) {
    assertSuiAddress(metadata.walletAddress, "deepbookSwap.walletAddress");
  }

  const route = Array.isArray(metadata.route)
    ? metadata.route.map((hop, index) => normalizeDeepBookRouteHop(hop, index))
    : [];
  if (route.length === 0) {
    throw new Error("deepbookSwap.route must contain at least one hop");
  }

  const inputAmount = parsePositiveU64(metadata.inputAmount, "deepbookSwap.inputAmount").toString();
  let expectedCoinType = metadata.inputCoinType;

  route.forEach((hop, index) => {
    const hopInput = hop.direction === "base_to_quote" ? hop.baseCoinType : hop.quoteCoinType;
    const hopOutput = hop.direction === "base_to_quote" ? hop.quoteCoinType : hop.baseCoinType;
    if (hopInput !== expectedCoinType) {
      throw new Error(`deepbookSwap.route[${index}] input coin type must be ${expectedCoinType}`);
    }
    expectedCoinType = hopOutput;
  });

  if (expectedCoinType !== metadata.outputCoinType) {
    throw new Error("deepbookSwap.outputCoinType does not match the final route output");
  }

  return {
    packageId: metadata.packageId.toLowerCase(),
    walletAddress: metadata.walletAddress?.toLowerCase(),
    inputCoinType: metadata.inputCoinType,
    outputCoinType: metadata.outputCoinType,
    inputAmount,
    deepCoinType: metadata.deepCoinType,
    route,
  };
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

const DEFAULT_SESSION_RECOVERY_GAS_RESERVE = 2_000_000n;

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

  private getAgentSessionContext(agentId: string): { agent: AgentConfig; policy: AgentPolicy } {
    const agent = this.storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const policy = this.storage.getPolicy(agentId);
    if (!policy) throw new Error(`Policy not found for agent: ${agentId}`);

    assertSuiAddress(agent.vaultId, "agent.vaultId");
    assertSuiAddress(agent.sessionKey, "agent.sessionKey");
    assertCoinType(agent.coinType, "agent.coinType");

    return { agent, policy };
  }

  private async assertSessionSignerMatches(agent: AgentConfig, sessionKeyPrivate: string): Promise<void> {
    const signerAddress = await resolveSuiAddress(sessionKeyPrivate);
    if (signerAddress.toLowerCase() !== agent.sessionKey.toLowerCase()) {
      throw new Error("sessionKeyPrivate does not match the selected agent session key");
    }
  }

  private async assertSessionUsable(
    agentId: string,
    sessionKeyPrivate: string,
  ): Promise<{ agent: AgentConfig; policy: AgentPolicy }> {
    const { agent, policy } = this.getAgentSessionContext(agentId);
    if (agent.revokedAt) {
      throw new Error(`Agent session key is revoked: ${agentId}`);
    }

    assertSuiAddress(agent.sessionKey, "sessionKey");
    assertSuiAddress(agent.vaultId, "vaultId");
    assertCoinType(agent.coinType);
    parsePositiveU64(policy.maxPerTx, "maxPerTx");
    parsePositiveU64(policy.maxTotal, "maxTotal");
    parsePositiveU64(policy.dailyBudget, "dailyBudget");
    parsePositiveU64(policy.weeklyBudget, "weeklyBudget");
    parsePositiveU64(policy.approvalThreshold, "approvalThreshold");
    if (policy.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new Error(`Agent session key is expired in local runtime: ${agentId}`);
    }
    await this.assertSessionSignerMatches(agent, sessionKeyPrivate);
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

  private async executeApprovedContractCall(
    intent: ContractCallIntent,
    sessionKeyPrivate: string,
    options?: { humanApproved?: boolean }
  ): Promise<PaymentResult> {
    const { agent } = await this.assertSessionUsable(intent.agentId, sessionKeyPrivate);

    const metadata = normalizeContractCallMetadata(intent.contractCall);

    const whitelisted =
      metadata.walletAddress
        ? Boolean(this.storage.getContractWhitelistEntry(metadata.walletAddress, metadata.packageId))
        : false;

    const hardResult = {
      passed: true,
      violations: [] as string[],
      triggeredRules: whitelisted
        ? ["contractWhitelist:pass"]
        : [metadata.walletAddress ? "contractWhitelist:missing" : "walletAddress:missing", "approval:required"],
      requiresApproval: !whitelisted,
    };

    const aggregated: AggregatedDecision = {
      decision: whitelisted || options?.humanApproved ? "allow" : "require_approval",
      hardPolicy: hardResult,
      aiRisk: {
        score: whitelisted ? 0 : 0.2,
        level: "low",
        reasons: whitelisted ? ["contract_whitelist_match"] : ["contract_whitelist_miss"],
        modelVersion: "contract-call-v1",
      },
    };

    let txHash: string | undefined;
    let gasUsed: string | undefined;
    let result: "success" | "failed" | "rejected" | "pending";
    let error: string | undefined;

    if (aggregated.decision === "allow") {
      try {
        const chainResult = await this.chain.executeMoveCall({
          signerSecretKey: sessionKeyPrivate,
          packageId: metadata.packageId,
          module: metadata.module,
          functionName: metadata.functionName,
          typeArguments: metadata.typeArguments,
          arguments: metadata.arguments,
        });
        txHash = chainResult.digest;
        gasUsed = parseGasUsed(chainResult.rawResponse);
        result = "success";
      } catch (err: unknown) {
        result = "failed";
        error = translateMoveCallExecutionError(err, {
          sessionKey: agent.sessionKey,
          target: metadata.target ?? buildContractCallTarget(metadata),
        });
      }
    } else if (aggregated.decision === "require_approval") {
      result = "pending";
    } else {
      result = "rejected";
    }

    const receipt = this.auditLogger.createReceipt(
      {
        taskId: intent.taskId,
        agentId: intent.agentId,
        reason: intent.reason,
        recipient: metadata.packageId,
        token: agent.coinType,
        amount: "0",
        category: "contract_call",
        operation: "contract_call",
        contractCall: metadata,
      },
      aggregated,
      {
        userId: agent.userId,
        agentType: agent.agentType,
        humanApproved: !!options?.humanApproved,
        signerType: "sui_session_key",
        txHash,
        result,
        gasUsed,
      }
    );
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

  private async executeApprovedDeepBookSwap(
    intent: DeepBookSwapIntent,
    sessionKeyPrivate: string,
    options?: { humanApproved?: boolean }
  ): Promise<PaymentResult> {
    const { agent } = await this.assertSessionUsable(intent.agentId, sessionKeyPrivate);

    const metadata = normalizeDeepBookSwapMetadata(intent.deepbookSwap);

    const whitelisted =
      metadata.walletAddress
        ? Boolean(this.storage.getContractWhitelistEntry(metadata.walletAddress, metadata.packageId))
        : false;

    const hardResult = {
      passed: true,
      violations: [] as string[],
      triggeredRules: whitelisted
        ? ["contractWhitelist:pass", "deepbookSwap:pass"]
        : [metadata.walletAddress ? "contractWhitelist:missing" : "walletAddress:missing", "approval:required"],
      requiresApproval: !whitelisted,
    };

    const aggregated: AggregatedDecision = {
      decision: whitelisted || options?.humanApproved ? "allow" : "require_approval",
      hardPolicy: hardResult,
      aiRisk: {
        score: whitelisted ? 0 : 0.2,
        level: "low",
        reasons: whitelisted ? ["contract_whitelist_match", "deepbook_swap_route"] : ["contract_whitelist_miss"],
        modelVersion: "deepbook-swap-v1",
      },
    };

    let txHash: string | undefined;
    let gasUsed: string | undefined;
    let result: "success" | "failed" | "rejected" | "pending";
    let error: string | undefined;

    if (aggregated.decision === "allow") {
      try {
        const chainResult = await this.chain.executeDeepBookSwap({
          signerSecretKey: sessionKeyPrivate,
          packageId: metadata.packageId,
          inputCoinType: metadata.inputCoinType,
          inputAmount: metadata.inputAmount,
          deepCoinType: metadata.deepCoinType,
          route: metadata.route,
        });
        txHash = chainResult.digest;
        gasUsed = parseGasUsed(chainResult.rawResponse);
        result = "success";
      } catch (err: unknown) {
        result = "failed";
        error = translateDeepBookExecutionError(err, {
          sessionKey: agent.sessionKey,
          packageId: metadata.packageId,
          inputAmount: metadata.inputAmount,
          inputCoinType: metadata.inputCoinType,
          outputCoinType: metadata.outputCoinType,
        });
      }
    } else if (aggregated.decision === "require_approval") {
      result = "pending";
    } else {
      result = "rejected";
    }

    const receipt = this.auditLogger.createReceipt(
      {
        taskId: intent.taskId,
        agentId: intent.agentId,
        reason: intent.reason,
        recipient: metadata.packageId,
        token: metadata.inputCoinType,
        amount: metadata.inputAmount,
        category: "deepbook_swap",
        operation: "deepbook_swap",
        deepbookSwap: metadata,
      },
      aggregated,
      {
        userId: agent.userId,
        agentType: agent.agentType,
        humanApproved: !!options?.humanApproved,
        signerType: "sui_session_key",
        txHash,
        result,
        gasUsed,
      }
    );
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
        operation: "payment",
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

  async requestContractCall(
    intent: ContractCallIntent,
    sessionKeyPrivate: string
  ): Promise<PaymentResult> {
    const normalizedIntent: ContractCallIntent = {
      ...intent,
      contractCall: normalizeContractCallMetadata(intent.contractCall),
    };
    const execution = await this.executeApprovedContractCall(normalizedIntent, sessionKeyPrivate);

    if (execution.decision === "require_approval") {
      const approvalRequest: ApprovalRequest = {
        approvalId: randomUUID(),
        approvalToken: createApprovalToken(),
        operation: "contract_call",
        agentId: normalizedIntent.agentId,
        taskId: normalizedIntent.taskId,
        reason: normalizedIntent.reason,
        recipient: normalizedIntent.contractCall.packageId,
        token: this.config.coinType ?? DEFAULT_COIN_TYPE,
        amount: "0",
        status: "pending",
        channel: "telegram",
        contractCall: normalizedIntent.contractCall,
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

  async requestDeepBookSwap(
    intent: DeepBookSwapIntent,
    sessionKeyPrivate: string
  ): Promise<PaymentResult> {
    const normalizedIntent: DeepBookSwapIntent = {
      ...intent,
      deepbookSwap: normalizeDeepBookSwapMetadata(intent.deepbookSwap),
    };
    const execution = await this.executeApprovedDeepBookSwap(normalizedIntent, sessionKeyPrivate);

    if (execution.decision === "require_approval") {
      const approvalRequest: ApprovalRequest = {
        approvalId: randomUUID(),
        approvalToken: createApprovalToken(),
        operation: "deepbook_swap",
        agentId: normalizedIntent.agentId,
        taskId: normalizedIntent.taskId,
        reason: normalizedIntent.reason,
        recipient: normalizedIntent.deepbookSwap.packageId,
        token: normalizedIntent.deepbookSwap.inputCoinType,
        amount: normalizedIntent.deepbookSwap.inputAmount,
        status: "pending",
        channel: "telegram",
        deepbookSwap: normalizedIntent.deepbookSwap,
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

    let execution: PaymentResult;
    if (approval.operation === "contract_call") {
      if (!approval.contractCall) {
        throw new Error("Approval request is missing contract call details");
      }
      execution = await this.executeApprovedContractCall(
        {
          taskId: approval.taskId,
          agentId: approval.agentId,
          reason: approval.reason,
          contractCall: approval.contractCall,
        },
        agent.sessionKeyPrivate,
        { humanApproved: true },
      );
    } else if (approval.operation === "deepbook_swap") {
      if (!approval.deepbookSwap) {
        throw new Error("Approval request is missing DeepBook swap details");
      }
      execution = await this.executeApprovedDeepBookSwap(
        {
          taskId: approval.taskId,
          agentId: approval.agentId,
          reason: approval.reason,
          deepbookSwap: approval.deepbookSwap,
        },
        agent.sessionKeyPrivate,
        { humanApproved: true },
      );
    } else {
      execution = await this.executeApprovedPayment(
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
    }

    const nextStatus = execution.result === "success" ? "executed" : "failed";

    return this.storage.updateApprovalRequest(approval.approvalId, {
      status: nextStatus,
      resolvedAt: new Date().toISOString(),
      approvalNote: options?.note,
      requestedBy: options?.requestedBy,
      txHash: execution.txHash,
      executionPaymentId: execution.paymentId,
      executionError: execution.error,
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

  async requestContractCallForAgent(
    intent: ContractCallIntent
  ): Promise<PaymentResult> {
    const agent = this.storage.getAgent(intent.agentId);
    if (!agent) throw new Error(`Agent not found: ${intent.agentId}`);
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${intent.agentId}`);
    }

    return this.requestContractCall(intent, agent.sessionKeyPrivate);
  }

  async requestDeepBookSwapForAgent(
    intent: DeepBookSwapIntent
  ): Promise<PaymentResult> {
    const agent = this.storage.getAgent(intent.agentId);
    if (!agent) throw new Error(`Agent not found: ${intent.agentId}`);
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${intent.agentId}`);
    }

    return this.requestDeepBookSwap(intent, agent.sessionKeyPrivate);
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

  markLocalAgentRevoked(agentId: string, revokedAt?: string): AgentConfig {
    const agent = this.storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const nextRevokedAt = revokedAt ?? new Date().toISOString();
    this.storage.markAgentRevoked(agentId, nextRevokedAt);

    const updated = this.storage.getAgent(agentId);
    if (!updated) {
      throw new Error(`Agent not found after revocation update: ${agentId}`);
    }
    return updated;
  }

  async listSessionAssets(
    agentId: string,
    options?: { keepSuiGas?: bigint | number | string }
  ): Promise<{
    agentId: string;
    label: string;
    sessionKey: string;
    expiresAt: number;
    expired: boolean;
    revoked: boolean;
    assets: Array<{
      coinType: string;
      balance: string;
      recoverableBalance: string;
    }>;
  }> {
    const { agent, policy } = this.getAgentSessionContext(agentId);
    const keepSuiGas = BigInt(options?.keepSuiGas ?? DEFAULT_SESSION_RECOVERY_GAS_RESERVE);
    const balancesResponse = await this.chain.listBalances(agent.sessionKey);
    const balanceEntries = Array.isArray((balancesResponse as any)?.balances)
      ? (balancesResponse as any).balances
      : [];

    const assets = balanceEntries
      .map((entry: any): { coinType: string; balance: string; recoverableBalance: string } => {
        const coinType = String(entry?.coinType ?? "");
        const balance = String(entry?.coinBalance ?? entry?.balance ?? entry?.addressBalance ?? "0");
        const rawBalance = BigInt(balance || "0");
        const recoverableBalance =
          coinType.toLowerCase() === DEFAULT_COIN_TYPE.toLowerCase()
            ? rawBalance > keepSuiGas
              ? (rawBalance - keepSuiGas).toString()
              : "0"
            : rawBalance.toString();
        return {
          coinType,
          balance,
          recoverableBalance,
        };
      })
      .filter((asset: { coinType: string; balance: string; recoverableBalance: string }) => asset.coinType && BigInt(asset.balance) > 0n)
      .sort((left: { coinType: string }, right: { coinType: string }) => {
        if (left.coinType === agent.coinType) return -1;
        if (right.coinType === agent.coinType) return 1;
        return left.coinType.localeCompare(right.coinType);
      });

    return {
      agentId: agent.agentId,
      label: agent.label,
      sessionKey: agent.sessionKey,
      expiresAt: policy.validUntil,
      expired: policy.validUntil <= Math.floor(Date.now() / 1000),
      revoked: Boolean(agent.revokedAt),
      assets,
    };
  }

  async recoverSessionAssets(
    agentId: string,
    recipient: string,
    options?: {
      keepSuiGas?: bigint | number | string;
      coinTypes?: string[];
    }
  ): Promise<{
    agentId: string;
    label: string;
    sessionKey: string;
    recipient: string;
    txHash: string;
    recovered: Array<{
      coinType: string;
      balance: string;
      recoveredBalance: string;
    }>;
  }> {
    assertSuiAddress(recipient, "recipient");
    const { agent } = this.getAgentSessionContext(agentId);
    if (!agent.sessionKeyPrivate) {
      throw new Error(`Agent session private key is not stored locally: ${agentId}`);
    }

    await this.assertSessionSignerMatches(agent, agent.sessionKeyPrivate);

    const execution = await this.chain.recoverOwnedCoins({
      signerSecretKey: agent.sessionKeyPrivate,
      recipient,
      keepSuiGas: options?.keepSuiGas ?? DEFAULT_SESSION_RECOVERY_GAS_RESERVE,
      coinTypes: options?.coinTypes,
    });

    return {
      agentId: agent.agentId,
      label: agent.label,
      sessionKey: agent.sessionKey,
      recipient,
      txHash: execution.digest,
      recovered: execution.recovered,
    };
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

  upsertContractWhitelist(walletAddress: string, packageId: string, label?: string): ContractWhitelistEntry {
    assertSuiAddress(walletAddress, "walletAddress");
    assertSuiAddress(packageId, "packageId");

    const existing = this.storage.getContractWhitelistEntry(walletAddress, packageId);
    const now = new Date().toISOString();
    const entry: ContractWhitelistEntry = {
      entryId: existing?.entryId ?? randomUUID(),
      walletAddress: walletAddress.toLowerCase(),
      packageId: packageId.toLowerCase(),
      label: label?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.storage.saveContractWhitelistEntry(entry);
    return entry;
  }

  listContractWhitelist(walletAddress?: string): ContractWhitelistEntry[] {
    if (walletAddress) {
      assertSuiAddress(walletAddress, "walletAddress");
    }
    return this.storage.listContractWhitelistEntries(walletAddress);
  }

  removeContractWhitelist(walletAddress: string, packageId: string): boolean {
    assertSuiAddress(walletAddress, "walletAddress");
    assertSuiAddress(packageId, "packageId");
    return this.storage.deleteContractWhitelistEntry(walletAddress, packageId);
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

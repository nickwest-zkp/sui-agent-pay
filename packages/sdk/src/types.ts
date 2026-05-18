import type { SuiAppConfig } from "./sui-types";
import { SUI_NETWORKS, SUI_TYPE_ARG } from "./sui-types";

export type AgentType = "long_lived" | "temporary";

export interface AgentConfig {
  agentId: string;
  label: string;
  agentType: AgentType;
  userId: string;
  sessionKey: string;
  sessionKeyPrivate?: string;
  vaultId: string;
  coinType: string;
  createdAt: string;
  revokedAt?: string;
}

export interface AgentPolicy {
  policyId: string;
  agentId: string;
  maxPerTx: string;
  maxTotal: string;
  dailyBudget: string;
  weeklyBudget: string;
  allowedRecipients: string[];
  allowedTokens: string[];
  allowedMethods: string[];
  approvalThreshold: string;
  taskBinding: boolean;
  retryPolicy: RetryPolicy;
  validUntil: number;
}

export interface RetryPolicy {
  maxRetries: number;
  sameRecipientOnly: boolean;
}

export interface PaymentIntent {
  taskId: string;
  agentId: string;
  reason: string;
  recipient: string;
  token: string;
  amount: string;
  category?: string;
}

export type Decision = "allow" | "require_approval" | "deny" | "error";

export interface PaymentResult {
  paymentId: string;
  decision: Decision;
  result: "success" | "failed" | "pending" | "rejected";
  txHash?: string;
  receipt: AuditReceipt;
  error?: string;
  approvalRequest?: ApprovalRequest;
}

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface ApprovalRequest {
  approvalId: string;
  approvalToken: string;
  agentId: string;
  taskId: string;
  reason: string;
  recipient: string;
  token: string;
  amount: string;
  status: ApprovalRequestStatus;
  channel: "telegram" | "manual";
  sourcePaymentId?: string;
  requestedBy?: string;
  approvalNote?: string;
  createdAt: string;
  resolvedAt?: string;
  txHash?: string;
  executionPaymentId?: string;
}

export interface TelegramBinding {
  bindingId: string;
  walletAddress: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
}

export interface HardPolicyResult {
  passed: boolean;
  violations: string[];
  triggeredRules: string[];
  requiresApproval: boolean;
}

export type RiskLevel = "low" | "medium" | "high";
export type OnChainRiskLevel = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH";

export interface AgentIdentityInfo {
  agentId: number;
  owner: string;
  agentURI: string;
  agentWallet: string;
  active: boolean;
  registeredAt: number;
}

export interface ReputationSummaryInfo {
  count: number;
  totalValue: number;
  decimals: number;
}

export interface ReputationAssessment {
  registered: boolean;
  riskLevel: OnChainRiskLevel;
  avgScore: number;
}

export interface AiRiskResult {
  score: number;
  level: RiskLevel;
  reasons: string[];
  modelVersion: string;
}

export interface AggregatedDecision {
  decision: Decision;
  hardPolicy: HardPolicyResult;
  aiRisk: AiRiskResult;
}

export interface AuditReceipt {
  paymentId: string;
  taskId: string;
  agentId: string;
  agentType: AgentType;
  userId: string;
  reason: string;
  recipient: string;
  token: string;
  amount: string;
  category?: string;
  hardPolicy: HardPolicyResult;
  aiRisk: AiRiskResult;
  finalDecision: Decision;
  humanApproved: boolean;
  signerType: string;
  txHash?: string;
  result: string;
  gasUsed?: string;
  timestamp: string;
}

export interface SessionKeyInfo {
  address: string;
  maxPerTx: string;
  maxTotal: string;
  spent: string;
  expiry: number;
  allowedRecipient: string;
  allowedToken: string;
  exists: boolean;
  revoked: boolean;
}

export interface BudgetRecord {
  agentId: string;
  date: string;
  dailySpent: string;
  txCount: number;
}

export interface PaymentProvider {
  name: string;
  preparePayment(intent: PaymentIntent): Promise<{ data: string; to: string }>;
  executePayment(
    prepared: { data: string; to: string },
    sessionKeyPrivate: string
  ): Promise<{ txHash: string; success: boolean }>;
  getReceipt(txHash: string): Promise<{ gasUsed: string; status: boolean }>;
}

export type AppConfig = SuiAppConfig;

export const AGENT_TEMPLATES = {
  long_lived: {
    validity: 7 * 24 * 60 * 60,
    maxPerTx: "200000000",
    maxTotal: "5000000000",
    dailyBudget: "1000000000",
    weeklyBudget: "4000000000",
    approvalThreshold: "100000000",
    retryPolicy: { maxRetries: 3, sameRecipientOnly: true },
    taskBinding: false,
  },
  temporary: {
    validity: 4 * 60 * 60,
    maxPerTx: "50000000",
    maxTotal: "500000000",
    dailyBudget: "500000000",
    weeklyBudget: "500000000",
    approvalThreshold: "30000000",
    retryPolicy: { maxRetries: 1, sameRecipientOnly: true },
    taskBinding: true,
  },
} as const;

export const SUI_DEFAULT_NETWORK = SUI_NETWORKS["sui-testnet"];
export const DEFAULT_COIN_TYPE = SUI_TYPE_ARG;

export type SettlementType = "direct" | "x402";

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  description?: string;
  resource?: string;
  maxTimeoutSeconds?: number;
}

export interface X402HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  agentId: string;
  taskId: string;
  reason: string;
}

export interface X402HttpResult {
  httpStatus: number;
  responseBody: string;
  responseHeaders: Record<string, string>;
  paymentResult?: PaymentResult;
  paid: boolean;
  reputationWarning?: string;
  counterpartyReputation?: ReputationAssessment;
}

export interface PaidService {
  serviceId: string;
  ownerAgentId?: string;
  url: string;
  description: string;
  priceAmount: string;
  priceToken: string;
  payToAddress: string;
  network: string;
  scheme: string;
  createdAt: string;
}

export interface InterAgentSettlementResult {
  httpResult: X402HttpResult;
  settlementType: SettlementType;
  counterpartyService: string;
  paymentId?: string;
  txHash?: string;
  reputationWarning?: string;
  counterpartyReputation?: ReputationAssessment;
}

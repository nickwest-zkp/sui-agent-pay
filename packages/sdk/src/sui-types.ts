export type SuiNetwork = "sui-localnet" | "sui-devnet" | "sui-testnet" | "sui-mainnet";

export type SuiRiskLevel = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH";

export interface SuiMoveModules {
  packageId: string;
  vaultModule: string;
  registryModule: string;
}

export interface SuiAppConfig {
  network: SuiNetwork;
  fullnodeUrl: string;
  ownerAddress: string;
  dbPath: string;
  move: SuiMoveModules;
  vaultId?: string;
  registryId?: string;
  coinType?: string;
}

export interface SuiSessionPermission {
  sessionKey: string;
  maxPerTx: string;
  maxTotal: string;
  spent: string;
  expiryMs: string;
  allowedRecipient: string;
  coinType: string;
  revoked: boolean;
}

export interface SuiAgentIdentity {
  agentId: string;
  owner: string;
  agentUri: string;
  paymentAddress: string;
  active: boolean;
  registeredAtMs: string;
}

export interface SuiReputationSummary {
  totalScore: string;
  feedbackCount: string;
  lastUpdatedMs: string;
  riskLevel: SuiRiskLevel;
}

export interface SuiTransactionExecutionResult {
  digest: string;
  signerAddress: string;
  rawResponse: unknown;
}

export interface SuiCreateVaultParams {
  signerSecretKey: string;
  coinType?: string;
}

export interface SuiDepositParams {
  signerSecretKey: string;
  vaultId: string;
  coinObjectId: string;
  coinType?: string;
}

export interface SuiWithdrawParams {
  signerSecretKey: string;
  vaultId: string;
  amount: bigint | number | string;
  recipient?: string;
  coinType?: string;
}

export interface SuiRegisterSessionKeyParams {
  signerSecretKey: string;
  vaultId: string;
  sessionKeyAddress: string;
  maxPerTx: bigint | number | string;
  maxTotal: bigint | number | string;
  expiryMs: bigint | number | string;
  allowedRecipient?: string;
  coinType?: string;
}

export interface SuiRevokeSessionKeyParams {
  signerSecretKey: string;
  vaultId: string;
  sessionKeyAddress: string;
  coinType?: string;
}

export interface SuiExecutePaymentParams {
  signerSecretKey: string;
  vaultId: string;
  recipient: string;
  amount: bigint | number | string;
  coinType?: string;
}

export interface SuiSetPausedParams {
  signerSecretKey: string;
  vaultId: string;
  paused: boolean;
  coinType?: string;
}

export interface SuiCreateRegistryParams {
  signerSecretKey: string;
}

export interface SuiRegisterAgentParams {
  signerSecretKey: string;
  registryId: string;
  agentUri: string;
  paymentAddress?: string;
}

export interface SuiGiveFeedbackParams {
  signerSecretKey: string;
  registryId: string;
  agentId: bigint | number | string;
  score: bigint | number | string;
}

export const SUI_NETWORKS: Record<SuiNetwork, { grpcUrl: string; sdkNetwork: "localnet" | "devnet" | "testnet" | "mainnet" }> = {
  "sui-localnet": {
    grpcUrl: "http://127.0.0.1:9000",
    sdkNetwork: "localnet",
  },
  "sui-devnet": {
    grpcUrl: "https://fullnode.devnet.sui.io:443",
    sdkNetwork: "devnet",
  },
  "sui-testnet": {
    grpcUrl: "https://fullnode.testnet.sui.io:443",
    sdkNetwork: "testnet",
  },
  "sui-mainnet": {
    grpcUrl: "https://fullnode.mainnet.sui.io:443",
    sdkNetwork: "mainnet",
  },
};

export const SUI_CLOCK_OBJECT_ID = "0x6";
export const SUI_TYPE_ARG = "0x2::sui::SUI";

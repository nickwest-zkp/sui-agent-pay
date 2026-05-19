"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getDeepBookDemoSummary } from "~~/lib/deepbook";
import {
  SUI_COIN_TYPE,
  ZERO_ADDRESS,
  appConfig,
  formatAmount,
  parseAmountInput,
  shortenAddress,
} from "~~/lib/sui-app";
import { ConnectButton } from "~~/lib/sui-connect-button";
import { useCurrentAccount, useCurrentClient, useCurrentNetwork, useDAppKit } from "~~/lib/sui-wallet-core";

type BackendStatus = {
  network: string;
  fullnodeUrl: string;
  ownerAddress: string;
  dbPath: string;
  storageMode: "json";
  vaultId: string;
  registryId: string;
  coinType: string;
  move: {
    packageId: string;
    vaultModule: string;
    registryModule: string;
  };
  counts: {
    agents: number;
    recentReceipts: number;
    paidServices: number;
  };
};

type BackendAgent = {
  agentId: string;
  label: string;
  agentType: "long_lived" | "temporary";
  userId: string;
  sessionKey: string;
  vaultId: string;
  coinType: string;
  createdAt: string;
  revokedAt?: string;
  hasStoredSessionKey: boolean;
  session?: {
    maxPerTx: string;
    maxTotal: string;
    spent: string;
    expiry: number;
    allowedRecipient: string;
  };
};

type BackendReceipt = {
  paymentId: string;
  agentId: string;
  operation?: "payment" | "contract_call" | "deepbook_swap";
  reason: string;
  recipient: string;
  amount: string;
  result: string;
  finalDecision: string;
  txHash?: string;
  timestamp: string;
  contractCall?: {
    target: string;
  };
};

type BackendService = {
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
};

type BackendApproval = {
  approvalId: string;
  approvalToken: string;
  operation?: "payment" | "contract_call" | "deepbook_swap";
  agentId: string;
  taskId: string;
  reason: string;
  recipient: string;
  token: string;
  amount: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  channel: "telegram" | "manual";
  createdAt: string;
  resolvedAt?: string;
  txHash?: string;
  contractCall?: {
    target: string;
  };
};

type BackendTelegramBinding = {
  bindingId: string;
  walletAddress: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
};

type BackendContractWhitelistEntry = {
  entryId: string;
  walletAddress: string;
  packageId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
};

type BackendSessionLifecycle = {
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
};

type ContractCallArgumentInput = {
  kind: "object" | "address" | "u64" | "string" | "bool";
  value: string | boolean;
};

type MockAgentResponse = {
  paymentResult?: {
    decision?: string;
    result?: string;
    approvalRequest?: BackendApproval;
  };
  telegram?: {
    sent?: boolean;
    approveUrl?: string;
    rejectUrl?: string;
    error?: string;
    details?: string;
  };
};

type RuntimeActionResponse = {
  decision?: string;
  result?: string;
  approvalRequest?: BackendApproval;
};

const deepBookDemoSummary = getDeepBookDemoSummary();

function scopedObjectKey(kind: "vault" | "registry", network: string, address: string) {
  return `sui-agent-pay:${network}:${address.toLowerCase()}:${kind}`;
}

function unwrapTransactionResponse(raw: any) {
  if (raw?.Transaction) return raw.Transaction;
  if (raw?.FailedTransaction) return raw.FailedTransaction;
  return raw;
}

function getTransactionDigest(raw: any): string {
  const tx = unwrapTransactionResponse(raw);
  return raw?.Transaction?.digest ?? raw?.digest ?? tx?.digest ?? "";
}

function getMoveEventJson(raw: any, moduleName: string, eventName: string): Record<string, unknown> | null {
  const tx = unwrapTransactionResponse(raw);
  const events = Array.isArray(tx?.events) ? tx.events : Array.isArray(raw?.events) ? raw.events : [];

  for (const event of events) {
    const type = String(event?.type ?? event?.eventType ?? "");
    const moduleMatches = event?.module === moduleName || type.includes(`::${moduleName}::`);
    const eventMatches = type.includes(`::${eventName}`) || type.endsWith(eventName);
    if (!moduleMatches || !eventMatches) continue;

    const json = event?.parsedJson ?? event?.json;
    if (json && typeof json === "object") {
      return json as Record<string, unknown>;
    }
  }

  return null;
}

function getCreatedObjectId(raw: any, typeMarker: string): string | null {
  const tx = unwrapTransactionResponse(raw);
  const objectChanges = Array.isArray(tx?.objectChanges)
    ? tx.objectChanges
    : Array.isArray(raw?.objectChanges)
      ? raw.objectChanges
      : [];

  for (const change of objectChanges) {
    const objectType = String(change?.objectType ?? "");
    if (change?.type === "created" && objectType.includes(typeMarker) && typeof change.objectId === "string") {
      return change.objectId;
    }
  }

  const changedObjects = Array.isArray(tx?.effects?.changedObjects) ? tx.effects.changedObjects : [];
  for (const entry of changedObjects) {
    const objectType = String(entry?.objectType ?? "");
    if (objectType.includes(typeMarker) && typeof entry?.objectId === "string") {
      return entry.objectId;
    }
  }

  return null;
}

function formatInputAmountValue(value: bigint | number | string, decimals: number) {
  const bigintValue = BigInt(value);
  const negative = bigintValue < 0n;
  const absolute = negative ? bigintValue * -1n : bigintValue;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${fraction ? `${whole.toString()}.${fraction.slice(0, 6)}` : whole.toString()}`;
}

function formatExpiryStatus(expiry: number) {
  const now = Math.floor(Date.now() / 1000);
  const delta = expiry - now;
  if (delta <= 0) {
    return "Expired";
  }

  const hours = Math.floor(delta / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m remaining`;
  }
  return `${Math.max(minutes, 1)}m remaining`;
}

function DashboardPageContent() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const account = useCurrentAccount();
  const network = useCurrentNetwork();

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastError, setLastError] = useState("");
  const [balanceLabel, setBalanceLabel] = useState(`0 ${appConfig.coinSymbol}`);
  const [vaultLookup, setVaultLookup] = useState("Not checked");
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeVaultId, setActiveVaultId] = useState("");

  const [agentName, setAgentName] = useState("Research Copilot");
  const [backendAgentType, setBackendAgentType] = useState<"long_lived" | "temporary">("long_lived");
  const [backendUserId, setBackendUserId] = useState("demo-user");

  const [depositAmount, setDepositAmount] = useState("0.1");
  const [withdrawAmount, setWithdrawAmount] = useState("0.05");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");

  const [sessionKeyAddress, setSessionKeyAddress] = useState("");
  const [maxPerTx, setMaxPerTx] = useState("0.1");
  const [maxTotal, setMaxTotal] = useState("1");
  const [approvalThreshold, setApprovalThreshold] = useState("0.01");
  const [expiryHours, setExpiryHours] = useState("24");
  const [allowedRecipient, setAllowedRecipient] = useState("");
  const [sessionGasAmount, setSessionGasAmount] = useState("0.02");

  const [paymentRecipient, setPaymentRecipient] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("0.01");

  const [backendBusyAction, setBackendBusyAction] = useState<string | null>(null);
  const [backendError, setBackendError] = useState("");
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendAgents, setBackendAgents] = useState<BackendAgent[]>([]);
  const [backendReceipts, setBackendReceipts] = useState<BackendReceipt[]>([]);
  const [backendServices, setBackendServices] = useState<BackendService[]>([]);
  const [backendApprovals, setBackendApprovals] = useState<BackendApproval[]>([]);
  const [backendTelegramBindings, setBackendTelegramBindings] = useState<BackendTelegramBinding[]>([]);
  const [backendContractWhitelist, setBackendContractWhitelist] = useState<BackendContractWhitelistEntry[]>([]);
  const [backendResult, setBackendResult] = useState("");
  const [trackedApprovalToken, setTrackedApprovalToken] = useState("");
  const [trackedApproval, setTrackedApproval] = useState<BackendApproval | null>(null);
  const [latestTelegramApproval, setLatestTelegramApproval] = useState<MockAgentResponse["telegram"] | null>(null);
  const [sdkAgentId, setSdkAgentId] = useState("");
  const [sdkSessionKey, setSdkSessionKey] = useState("");
  const [sdkPaymentReason, setSdkPaymentReason] = useState("agent runtime payment");
  const [sdkPaymentAmount, setSdkPaymentAmount] = useState("0.01");
  const [approvalChatId, setApprovalChatId] = useState("");
  const [whitelistPackageId, setWhitelistPackageId] = useState(
    appConfig.network === "sui-testnet" ? deepBookDemoSummary.packageId : appConfig.packageId || "",
  );
  const [whitelistLabel, setWhitelistLabel] = useState("");
  const [contractCallReason, setContractCallReason] = useState("Run agent contract call");
  const [contractPackageId, setContractPackageId] = useState(appConfig.packageId || "");
  const [contractModule, setContractModule] = useState("");
  const [contractFunctionName, setContractFunctionName] = useState("");
  const [contractTypeArguments, setContractTypeArguments] = useState("[]");
  const [contractArgumentsJson, setContractArgumentsJson] = useState(
    `[
  { "kind": "u64", "value": "1" }
]`,
  );
  const [mockAgentInstruction, setMockAgentInstruction] = useState(
    "Swap 0.01 SUI to USDC via DeepBook",
  );
  const [serviceUrl, setServiceUrl] = useState("https://example.com/agent");
  const [serviceDescription, setServiceDescription] = useState("Demo paid endpoint");
  const [servicePriceAmount, setServicePriceAmount] = useState("0.01");
  const [servicePayToAddress, setServicePayToAddress] = useState("");
  const [x402Url, setX402Url] = useState("https://example.com/paid");
  const [x402Method, setX402Method] = useState("GET");
  const [x402Reason, setX402Reason] = useState("agent runtime x402 fetch");
  const [x402Body, setX402Body] = useState("");
  const [verifyServiceId, setVerifyServiceId] = useState("");
  const [verifyReceiptHeader, setVerifyReceiptHeader] = useState("");

  useEffect(() => {
    if (account?.address) {
      setWithdrawRecipient(account.address);
      setPaymentRecipient(account.address);
      setServicePayToAddress(current => current || account.address);
    }
  }, [account?.address]);

  useEffect(() => {
    if (!account?.address || typeof window === "undefined") {
      setActiveVaultId("");
      return;
    }

    const storedVault = window.localStorage.getItem(scopedObjectKey("vault", appConfig.network, account.address));
    const configuredVaultForOwner =
      appConfig.ownerAddress && appConfig.ownerAddress.toLowerCase() === account.address.toLowerCase()
        ? appConfig.vaultId
        : "";

    setActiveVaultId(storedVault || configuredVaultForOwner);
  }, [account?.address]);

  useEffect(() => {
    void refreshBackend();
  }, []);

  const currentWalletBinding =
    account?.address
      ? backendTelegramBindings.find(binding => binding.walletAddress.toLowerCase() === account.address.toLowerCase()) ?? null
      : null;
  const currentWalletContractWhitelist =
    account?.address
      ? backendContractWhitelist.filter(entry => entry.walletAddress.toLowerCase() === account.address.toLowerCase())
      : [];

  useEffect(() => {
    setApprovalChatId(currentWalletBinding?.chatId ?? "");
  }, [account?.address, currentWalletBinding?.chatId]);

  useEffect(() => {
    if (!trackedApprovalToken) {
      setTrackedApproval(null);
      return;
    }

    const matchedApproval = backendApprovals.find(approval => approval.approvalToken === trackedApprovalToken) ?? null;
    if (matchedApproval) {
      setTrackedApproval(matchedApproval);
    }
  }, [backendApprovals, trackedApprovalToken]);

  useEffect(() => {
    if (!trackedApprovalToken) return;
    if (trackedApproval?.status && trackedApproval.status !== "pending" && trackedApproval.status !== "approved") {
      return;
    }

    let cancelled = false;

    const pollApproval = async () => {
      try {
        const approval = await apiRequest<BackendApproval>(`/api/approvals?token=${encodeURIComponent(trackedApprovalToken)}`);
        if (cancelled) return;

        setTrackedApproval(approval);
        setBackendApprovals(current => {
          const remaining = current.filter(item => item.approvalId !== approval.approvalId);
          return [approval, ...remaining].slice(0, 12);
        });

        if (approval.status !== "pending" && approval.status !== "approved") {
          const receipts = await apiRequest<BackendReceipt[]>("/api/audit-log?limit=12");
          if (cancelled) return;
          setBackendReceipts(receipts);
        }
      } catch {
        // Keep polling silent. The main backend error area should not flap on transient refresh failures.
      }
    };

    void pollApproval();
    const intervalId = window.setInterval(() => {
      void pollApproval();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [trackedApproval?.status, trackedApprovalToken]);

  useEffect(() => {
    async function loadSnapshot() {
      if (!account) {
        setBalanceLabel(`0 ${appConfig.coinSymbol}`);
        setVaultLookup("Wallet not connected");
        return;
      }

      try {
        const balance = await client.getBalance({
          owner: account.address,
          coinType: appConfig.coinType,
        });
        const totalBalance = balance.totalBalance || "0";

        setBalanceLabel(formatAmount(totalBalance, appConfig.coinDecimals, appConfig.coinSymbol));
      } catch {
        setBalanceLabel("Read failed");
      }

      if (activeVaultId) {
        try {
          await client.getObject({ id: activeVaultId, options: { showContent: true } });
          setVaultLookup("Shared object accessible");
        } catch {
          setVaultLookup("Object query failed");
        }
      } else {
        setVaultLookup("Not configured");
      }

    }

    void loadSnapshot();
  }, [account, activeVaultId, client, refreshKey]);

  function pushActivity(_item: unknown) {
    // Activity cards were removed from the dashboard. Keep call sites as no-ops to avoid wider churn.
  }

  const selectedBackendAgent = backendAgents.find(agent => agent.agentId === sdkAgentId) ?? null;
  const runnableBackendAgents = backendAgents.filter(
    agent =>
      agent.hasStoredSessionKey &&
      !agent.revokedAt &&
      (!agent.session?.expiry || agent.session.expiry > Math.floor(Date.now() / 1000)),
  );
  const runtimePayRequestExample = JSON.stringify(
    {
      agentId: sdkAgentId || "<agent-id>",
      reason: sdkPaymentReason,
      recipient: paymentRecipient || "<recipient>",
      token: appConfig.coinType,
      amount: parseAmountInput(sdkPaymentAmount || "0", appConfig.coinDecimals).toString(),
    },
    null,
    2,
  );
  const runtimeX402RequestExample = JSON.stringify(
    {
      agentId: sdkAgentId || "<agent-id>",
      url: x402Url,
      method: x402Method,
      reason: x402Reason,
      body: x402Body || undefined,
    },
    null,
    2,
  );
  const mockAgentRequestExample = JSON.stringify(
    {
      agentId: sdkAgentId || "<agent-id>",
      instruction: mockAgentInstruction,
      chatId: approvalChatId || "<telegram-chat-id>",
      walletAddress: account?.address || "<wallet-address>",
      coinType: appConfig.coinType,
      coinDecimals: appConfig.coinDecimals,
    },
    null,
    2,
  );
  const contractCallRequestExample = JSON.stringify(
    {
      agentId: sdkAgentId || "<agent-id>",
      reason: contractCallReason,
      walletAddress: account?.address || "<wallet-address>",
      packageId: contractPackageId || "<package-id>",
      module: contractModule || "<module>",
      functionName: contractFunctionName || "<function>",
      typeArguments: (() => {
        try {
          return JSON.parse(contractTypeArguments);
        } catch {
          return contractTypeArguments;
        }
      })(),
      arguments: (() => {
        try {
          return JSON.parse(contractArgumentsJson);
        } catch {
          return contractArgumentsJson;
        }
      })(),
    },
    null,
    2,
  );

  function rememberObject(kind: "vault", objectId: string) {
    if (!account?.address || typeof window === "undefined") return;

    window.localStorage.setItem(scopedObjectKey(kind, appConfig.network, account.address), objectId);
    setActiveVaultId(objectId);
  }

  async function apiRequest<T>(input: string, init?: RequestInit): Promise<T> {
    const apiKey = process.env.NEXT_PUBLIC_AGENT_PAY_API_KEY;
    const response = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-agent-pay-key": apiKey } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }
    return data;
  }

  function parseJsonArray<T>(raw: string, fieldName: string): T[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${fieldName} must be valid JSON`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON array`);
    }

    return parsed as T[];
  }

  async function sendTelegramApprovalRequest(approvalToken: string, text: string) {
    const resolvedChatId = approvalChatId.trim() || currentWalletBinding?.chatId || "";
    if (!resolvedChatId) {
      const missingChat = {
        sent: false,
        error: "No Telegram chat ID is available for this approval request.",
      };
      setLatestTelegramApproval(missingChat);
      return missingChat;
    }

    const telegram = await apiRequest<MockAgentResponse["telegram"]>("/api/tg/approve", {
      method: "POST",
      body: JSON.stringify({
        approvalToken,
        text,
        chatId: resolvedChatId,
        walletAddress: account?.address,
      }),
    });
    setLatestTelegramApproval(telegram ?? null);
    return telegram;
  }

  async function refreshBackend() {
    setBackendBusyAction("refresh");
    setBackendError("");

    try {
      const [status, agents, receipts, services, approvals, telegramBindings, contractWhitelist] = await Promise.all([
        apiRequest<BackendStatus>("/api/backend/status"),
        apiRequest<BackendAgent[]>("/api/agents?includeSession=true"),
        apiRequest<BackendReceipt[]>("/api/audit-log?limit=12"),
        apiRequest<BackendService[]>("/api/services"),
        apiRequest<BackendApproval[]>("/api/approvals?limit=12"),
        apiRequest<BackendTelegramBinding[]>("/api/tg-bindings"),
        apiRequest<BackendContractWhitelistEntry[]>("/api/contract-whitelist"),
      ]);

      setBackendStatus(status);
      setBackendAgents(agents);
      setBackendReceipts(receipts);
      setBackendServices(services);
      setBackendApprovals(approvals);
      setBackendTelegramBindings(telegramBindings);
      setBackendContractWhitelist(contractWhitelist);
      setSdkAgentId(current => current || agents[0]?.agentId || "");
      setVerifyServiceId(current => current || services[0]?.serviceId || "");
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to load backend state");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function saveTelegramBinding() {
    if (!account?.address) {
      setBackendError("Please connect a wallet before saving a Telegram binding.");
      return;
    }

    if (!approvalChatId.trim()) {
      setBackendError("Please enter a Telegram chat ID.");
      return;
    }

    setBackendBusyAction("save-tg-binding");
    setBackendError("");

    try {
      const data = await apiRequest<BackendTelegramBinding>("/api/tg-bindings", {
        method: "POST",
        body: JSON.stringify({
          walletAddress: account.address,
          chatId: approvalChatId.trim(),
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to save Telegram binding");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function deleteTelegramBinding(walletAddress: string) {
    setBackendBusyAction("delete-tg-binding");
    setBackendError("");

    try {
      const data = await apiRequest("/api/tg-bindings", {
        method: "DELETE",
        body: JSON.stringify({
          walletAddress,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      if (account?.address?.toLowerCase() === walletAddress.toLowerCase()) {
        setApprovalChatId("");
      }
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to delete Telegram binding");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function saveContractWhitelistEntry() {
    if (!account?.address) {
      setBackendError("Please connect a wallet before saving a contract whitelist entry.");
      return;
    }

    if (!whitelistPackageId.trim()) {
      setBackendError("Please enter a package ID to whitelist.");
      return;
    }

    setBackendBusyAction("save-contract-whitelist");
    setBackendError("");

    try {
      const data = await apiRequest<BackendContractWhitelistEntry>("/api/contract-whitelist", {
        method: "POST",
        body: JSON.stringify({
          walletAddress: account.address,
          packageId: whitelistPackageId.trim(),
          label: whitelistLabel.trim() || undefined,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to save contract whitelist entry");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function deleteContractWhitelistEntry(packageId: string) {
    if (!account?.address) {
      setBackendError("Please connect a wallet before deleting a contract whitelist entry.");
      return;
    }

    setBackendBusyAction("delete-contract-whitelist");
    setBackendError("");

    try {
      const data = await apiRequest("/api/contract-whitelist", {
        method: "DELETE",
        body: JSON.stringify({
          walletAddress: account.address,
          packageId,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to delete contract whitelist entry");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function registerPaidService() {
    setBackendBusyAction("register-service");
    setBackendError("");

    try {
      const data = await apiRequest<BackendService>("/api/services", {
        method: "POST",
        body: JSON.stringify({
          ownerAgentId: sdkAgentId || undefined,
          url: serviceUrl,
          description: serviceDescription,
          priceAmount: parseAmountInput(servicePriceAmount, appConfig.coinDecimals).toString(),
          priceToken: appConfig.coinType,
          payToAddress: servicePayToAddress,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to register service");
    } finally {
      setBackendBusyAction(null);
    }
  }





  async function verifyReceipt() {
    setBackendBusyAction("verify-receipt");
    setBackendError("");

    try {
      const data = await apiRequest("/api/x402/verify", {
        method: "POST",
        body: JSON.stringify({
          serviceId: verifyServiceId,
          receiptHeader: verifyReceiptHeader,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to verify receipt");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function syncAgentToRuntime() {
    if (!sessionKeyAddress) {
      setBackendError("Please generate or paste a session key address before syncing.");
      return;
    }

    if (!sdkSessionKey) {
      setBackendError("Please provide the session private key so the local agent runtime can use it.");
      return;
    }

    if (!activeVaultId) {
      setBackendError("Please create or select the active vault first.");
      return;
    }

    setBackendBusyAction("sync-agent");
    setBackendError("");

    try {
      const maxPerTxValue = parseAmountInput(maxPerTx, appConfig.coinDecimals).toString();
      const maxTotalValue = parseAmountInput(maxTotal, appConfig.coinDecimals).toString();
      const approvalThresholdValue = parseAmountInput(approvalThreshold, appConfig.coinDecimals).toString();
      const validity = Math.max(1, Number(expiryHours || "0")) * 60 * 60;

      const data = await apiRequest<{ agent: BackendAgent; policy: unknown }>("/api/agents", {
        method: "POST",
        body: JSON.stringify({
          label: agentName,
          agentType: backendAgentType,
          userId: backendUserId,
          sessionKey: sessionKeyAddress,
          sessionKeyPrivate: sdkSessionKey,
          vaultId: activeVaultId,
          coinType: appConfig.coinType,
          allowedRecipients: allowedRecipient ? [allowedRecipient] : [],
          allowedTokens: [appConfig.coinType],
          overrides: {
            maxPerTx: maxPerTxValue,
            maxTotal: maxTotalValue,
            dailyBudget: maxTotalValue,
            weeklyBudget: maxTotalValue,
            validity,
            approvalThreshold: approvalThresholdValue,
          },
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      setSdkAgentId(data.agent.agentId);
      pushActivity({
        kind: "success",
        title: "Agent synced to local runtime",
        detail: `${agentName} config and session signer are now stored in the backend runtime.`,
      });
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to sync agent");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function submitRuntimePayment() {
    setBackendBusyAction("sdk-payment");
    setBackendError("");

    try {
      const data = await apiRequest("/api/agent-runtime/pay", {
        method: "POST",
        body: JSON.stringify({
          agentId: sdkAgentId,
          reason: sdkPaymentReason,
          recipient: paymentRecipient,
          token: appConfig.coinType,
          amount: parseAmountInput(sdkPaymentAmount, appConfig.coinDecimals).toString(),
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      pushActivity({
        kind: "success",
        title: "Agent runtime payment",
        detail: `Backend runtime executed a payment for ${sdkAgentId || "selected agent"}.`,
      });
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to execute runtime payment");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function submitContractCall() {
    if (!sdkAgentId) {
      setBackendError("Please select a runtime-ready agent before executing a contract call.");
      return;
    }

    if (!account?.address) {
      setBackendError("Please connect a wallet so the runtime can resolve the correct contract whitelist.");
      return;
    }

    setBackendBusyAction("contract-call");
    setBackendError("");

    try {
      const typeArguments = parseJsonArray<string>(contractTypeArguments, "Type arguments");
      const contractArguments = parseJsonArray<ContractCallArgumentInput>(contractArgumentsJson, "Contract arguments");

      const data = await apiRequest<RuntimeActionResponse>("/api/agent-runtime/contract-call", {
        method: "POST",
        body: JSON.stringify({
          agentId: sdkAgentId,
          reason: contractCallReason,
          walletAddress: account.address,
          packageId: contractPackageId,
          module: contractModule,
          functionName: contractFunctionName,
          typeArguments,
          arguments: contractArguments,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      setTrackedApprovalToken(data.approvalRequest?.approvalToken ?? "");
      setTrackedApproval(data.approvalRequest ?? null);

      if (data.approvalRequest?.approvalToken) {
        await sendTelegramApprovalRequest(
          data.approvalRequest.approvalToken,
          `Approval required for contract call ${contractPackageId}::${contractModule}::${contractFunctionName}. Reason: ${contractCallReason}`,
        );
      } else {
        setLatestTelegramApproval(null);
      }

      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to execute runtime contract call");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function submitRuntimeX402() {
    setBackendBusyAction("x402-request");
    setBackendError("");

    try {
      const data = await apiRequest("/api/agent-runtime/x402", {
        method: "POST",
        body: JSON.stringify({
          url: x402Url,
          method: x402Method,
          body: x402Body || undefined,
          agentId: sdkAgentId,
          reason: x402Reason,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      pushActivity({
        kind: "success",
        title: "Agent runtime x402",
        detail: `Backend runtime issued an x402 request for ${sdkAgentId || "selected agent"}.`,
      });
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to execute runtime x402 request");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function submitMockAgentInstruction() {
    if (!sdkAgentId) {
      setBackendError("Please select a runtime-ready agent before running the demo agent.");
      return;
    }

    if (!approvalChatId.trim()) {
      setBackendError("Please enter the Telegram chat ID for the approval flow.");
      return;
    }

    setBackendBusyAction("mock-agent");
    setBackendError("");

    try {
      const data = await apiRequest<MockAgentResponse>("/api/mock-agent/pay", {
        method: "POST",
        body: JSON.stringify({
          agentId: sdkAgentId,
          instruction: mockAgentInstruction,
          chatId: approvalChatId.trim(),
          walletAddress: account?.address,
          coinType: appConfig.coinType,
          coinDecimals: appConfig.coinDecimals,
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      setLatestTelegramApproval(data.telegram ?? null);
      setTrackedApprovalToken(data.paymentResult?.approvalRequest?.approvalToken ?? "");
      setTrackedApproval(data.paymentResult?.approvalRequest ?? null);
      pushActivity({
        kind: "success",
        title: "Mock agent payment",
        detail: `Mock agent executed an instruction for ${sdkAgentId || "selected agent"}.`,
      });
      if (data.paymentResult?.approvalRequest?.approvalToken) {
        pushActivity({
          kind: "info",
          title: "Approval pending",
          detail: "Telegram approval was requested. This dashboard will keep polling until the payment is executed or rejected.",
        });
      }
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Mock agent failed");
    } finally {
      setBackendBusyAction(null);
    }
  }

  function loadAgentIntoForm(agent: BackendAgent) {
    setSdkAgentId(agent.agentId);
    setAgentName(agent.label);
    setBackendAgentType(agent.agentType);
    setBackendUserId(agent.userId);
    setSessionKeyAddress(agent.sessionKey);

    if (agent.session) {
      setMaxPerTx(formatInputAmountValue(agent.session.maxPerTx, appConfig.coinDecimals));
      setMaxTotal(formatInputAmountValue(agent.session.maxTotal, appConfig.coinDecimals));
      setAllowedRecipient(agent.session.allowedRecipient === ZERO_ADDRESS ? "" : agent.session.allowedRecipient);
      const remainingSeconds = Math.max(agent.session.expiry - Math.floor(Date.now() / 1000), 3600);
      setExpiryHours(String(Math.max(1, Math.ceil(remainingSeconds / 3600))));
    }
  }

  function generateSessionKey() {
    const keypair = Ed25519Keypair.generate();
    const address = keypair.toSuiAddress();

    setSessionKeyAddress(address);
    setSdkSessionKey(keypair.getSecretKey());
    pushActivity({
      kind: "info",
      title: "Session key generated",
      detail: address,
    });
  }

  function prepareRotationForAgent(agent: BackendAgent) {
    loadAgentIntoForm(agent);
    const keypair = Ed25519Keypair.generate();
    const address = keypair.toSuiAddress();

    setSessionKeyAddress(address);
    setSdkSessionKey(keypair.getSecretKey());
    setBackendResult(
      JSON.stringify(
        {
          action: "prepare_rotation",
          agentId: agent.agentId,
          previousSessionKey: agent.sessionKey,
          replacementSessionKey: address,
          nextSteps: [
            "Register the replacement session key on-chain.",
            "Recover assets from the expired session key if needed.",
            "Revoke the old session key on-chain.",
            "Sync the replacement session key into the local runtime.",
          ],
        },
        null,
        2,
      ),
    );
  }

  async function inspectSessionAssets(agent: BackendAgent) {
    setBackendBusyAction(`inspect-session-${agent.agentId}`);
    setBackendError("");

    try {
      const data = await apiRequest<BackendSessionLifecycle>(
        `/api/agents/session-lifecycle?agentId=${encodeURIComponent(agent.agentId)}`,
      );
      setBackendResult(JSON.stringify(data, null, 2));
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to inspect session assets");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function recoverSessionAssets(agent: BackendAgent) {
    if (!account?.address) {
      setBackendError("Please connect the destination wallet before recovering session assets.");
      return;
    }

    setBackendBusyAction(`recover-session-${agent.agentId}`);
    setBackendError("");

    try {
      const data = await apiRequest("/api/agents/session-lifecycle", {
        method: "POST",
        body: JSON.stringify({
          action: "recover",
          agentId: agent.agentId,
          recipient: account.address,
          keepSuiGas: "2000000",
        }),
      });

      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to recover session assets");
    } finally {
      setBackendBusyAction(null);
    }
  }

  async function markLocalSessionRevoked(agent: BackendAgent) {
    setBackendBusyAction(`mark-revoked-${agent.agentId}`);
    setBackendError("");

    try {
      const data = await apiRequest("/api/agents/session-lifecycle", {
        method: "POST",
        body: JSON.stringify({
          action: "mark_revoked",
          agentId: agent.agentId,
        }),
      });
      setBackendResult(JSON.stringify(data, null, 2));
      await refreshBackend();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Failed to mark the session as revoked");
    } finally {
      setBackendBusyAction(null);
    }
  }

  function revokeSessionKeyOnChain(agent: BackendAgent) {
    if (!agent.vaultId) {
      setBackendError("The selected agent does not have a vault ID.");
      return;
    }

    void runTransaction(
      `Revoke Session Key ${shortenAddress(agent.sessionKey)}`,
      tx => {
        tx.moveCall({
          target: `${vaultTargetBase}::revoke_session_key`,
          typeArguments: [appConfig.coinType],
          arguments: [
            tx.object(agent.vaultId),
            tx.pure.address(agent.sessionKey),
          ],
        });
      },
      async details => {
        await markLocalSessionRevoked(agent);
        setBackendResult(
          JSON.stringify(
            {
              action: "revoke_session_key",
              agentId: agent.agentId,
              sessionKey: agent.sessionKey,
              digest: getTransactionDigest(details),
            },
            null,
            2,
          ),
        );
      },
    );
  }

  async function runTransaction(
    actionName: string,
    builder: (tx: Transaction) => void,
    onSuccess?: (details: any, digest: string) => Promise<void> | void,
  ) {
    if (!account) {
      setLastError("Please connect your Sui wallet first.");
      return;
    }

    setBusyAction(actionName);
    setLastError("");

    try {
      const tx = new Transaction();
      builder(tx);

      const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if ("FailedTransaction" in result && result.FailedTransaction) {
        throw new Error(result.FailedTransaction.status.error?.message || `${actionName} failed`);
      }

      const digest = getTransactionDigest(result);
      let details: any = result;
      if (digest && typeof (client as any).getTransactionBlock === "function") {
        try {
          details = await (client as any).getTransactionBlock({
            digest,
            options: {
              showEffects: true,
              showEvents: true,
              showObjectChanges: true,
            },
          });
        } catch {
          details = result;
        }
      }

      pushActivity({
        kind: "success",
        title: actionName,
        detail: `${actionName} submitted to ${network ?? appConfig.networkLabel}.`,
        digest,
      });

      await onSuccess?.(details, digest);

      setRefreshKey(current => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : `${actionName} failed`;
      setLastError(message);
      pushActivity({
        kind: "error",
        title: actionName,
        detail: message,
      });
    } finally {
      setBusyAction(null);
    }
  }

  const vaultTargetBase = `${appConfig.packageId}::${appConfig.vaultModule}`;
  const vaultTypeMarker = `::${appConfig.vaultModule}::AgentVault`;
  const runtimePayEndpoint = "/api/agent-runtime/pay";
  const runtimeX402Endpoint = "/api/agent-runtime/x402";
  const trackedApprovalPending =
    trackedApproval && (trackedApproval.status === "pending" || trackedApproval.status === "approved");
  const latestBackendAgent = backendAgents[0] ?? null;
  const olderBackendAgents = backendAgents.slice(1);
  const latestBackendReceipt = backendReceipts[0] ?? null;
  const olderBackendReceipts = backendReceipts.slice(1);
  const latestBackendApproval = backendApprovals[0] ?? null;
  const olderBackendApprovals = backendApprovals.slice(1);
  const latestBackendService = backendServices[0] ?? null;
  const olderBackendServices = backendServices.slice(1);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredBackendAgents = backendAgents.filter(
    agent => !agent.revokedAt && Boolean(agent.session?.expiry) && (agent.session?.expiry ?? 0) <= nowSeconds,
  );
  const expiringSoonBackendAgents = backendAgents.filter(agent => {
    const expiry = agent.session?.expiry ?? 0;
    return !agent.revokedAt && expiry > nowSeconds && expiry - nowSeconds <= 6 * 60 * 60;
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-[2rem] border border-base-300/70 bg-[linear-gradient(135deg,rgba(15,23,42,0.98),rgba(8,47,73,0.96)_48%,rgba(13,148,136,0.88))] p-7 text-white shadow-2xl shadow-cyan-950/15">
          <div className="flex items-center gap-4">
            <Image src="/logo.svg" alt="Sui Agent Pay logo" width={56} height={56} priority />
            <span className="badge border-white/20 bg-white/10 px-3 py-3 text-[11px] uppercase tracking-[0.24em] text-white/80">
              Sui-only Agent Wallet
            </span>
          </div>
          <h1 className="mt-5 text-3xl font-black tracking-tight lg:text-5xl">Sui Agent Pay</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-white/75 lg:text-base">
            This page is a minimal configuration console for the agent wallet demo. The only path that matters is:
            create vault, authorize a session key, sync a local runtime agent, then let a mock agent spend through it.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-white/50">Wallet</p>
              <p className="mt-3 font-mono text-sm">{account ? shortenAddress(account.address) : "Not connected"}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-white/50">Network</p>
              <p className="mt-3 text-sm">{network ?? appConfig.networkLabel}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
              <p className="text-xs uppercase tracking-[0.22em] text-white/50">Balance</p>
              <p className="mt-3 text-sm">{balanceLabel}</p>
            </div>
          </div>
        </div>

        <div className="rounded-[2rem] border border-base-300/70 bg-base-100 p-6 shadow-xl shadow-base-300/25">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-base-content/45">On-chain Objects</p>
          <div className="mt-5 space-y-4 text-sm">
            <div>
              <p className="text-base-content/50">Move Package</p>
              <p className="mt-1 font-mono">{shortenAddress(appConfig.packageId)}</p>
            </div>
            <div>
              <p className="text-base-content/50">Vault</p>
              <p className="mt-1 font-mono">{activeVaultId ? shortenAddress(activeVaultId) : "Not created"}</p>
              <p className="mt-1 text-xs text-base-content/45">{vaultLookup}</p>
            </div>
          </div>
          <div className="mt-6">
            <ConnectButton />
          </div>
          {!!lastError && (
            <div className="mt-4 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-base-content/75">
              {lastError}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-6">
        <div className="grid content-start gap-6 xl:grid-cols-[0.82fr_1fr_1.12fr]">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">1. Runtime Agent Config</p>
                <p className="mt-1 text-sm text-base-content/55">
                  This is the local agent identity used by the runtime. Chain-side agent registry is not part of the minimal demo.
                </p>
              </div>
              <span className="badge badge-outline">Local only</span>
            </div>

            <div className="mt-5 space-y-3">
              <input
                className="input input-bordered w-full"
                value={agentName}
                onChange={event => setAgentName(event.target.value)}
                placeholder="Agent label"
              />
              <div className="grid gap-3 md:grid-cols-2">
                <select
                  className="select select-bordered w-full"
                  value={backendAgentType}
                  onChange={event => setBackendAgentType(event.target.value as "long_lived" | "temporary")}
                >
                  <option value="long_lived">long_lived</option>
                  <option value="temporary">temporary</option>
                </select>
                <input
                  className="input input-bordered w-full"
                  value={backendUserId}
                  onChange={event => setBackendUserId(event.target.value)}
                  placeholder="User ID"
                />
              </div>
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4 text-sm leading-6 text-base-content/70">
                This config exists only in the local backend runtime. It binds the agent ID to vault, session key, and policy.
              </div>
            </div>
          </div>
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">2. Vault Fund Operations</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Defaults to {appConfig.coinSymbol}. This interface mainly covers SUI fund flows.
                </p>
              </div>
              <span className="badge badge-outline">{appConfig.coinSymbol}</span>
            </div>

            <div className="mt-5 space-y-3">
              {!activeVaultId && (
                <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-base-content/75">
                  Current wallet has no Vault bound. Please create or confirm a Vault object first.
                </div>
              )}
              <button
                className="btn btn-outline btn-sm"
                disabled={busyAction !== null || !account || !!activeVaultId}
                onClick={() =>
                  runTransaction(
                    "Create Vault",
                    tx => {
                      tx.moveCall({
                        target: `${vaultTargetBase}::create_vault`,
                        typeArguments: [appConfig.coinType],
                      });
                    },
                    details => {
                      const eventJson = getMoveEventJson(details, appConfig.vaultModule, "VaultCreated");
                      const vaultId =
                        (typeof eventJson?.vault_id === "string" ? eventJson.vault_id : null) ??
                        getCreatedObjectId(details, vaultTypeMarker);

                      if (vaultId) {
                        rememberObject("vault", vaultId);
                        pushActivity({
                          kind: "success",
                          title: "Vault bound",
                          detail: `Current wallet will automatically use ${shortenAddress(vaultId)} from now on.`,
                        });
                      } else {
                        pushActivity({
                          kind: "info",
                          title: "Vault created",
                          detail: "Wallet receipt did not return object ID. Please copy the Vault ID from transaction details and refresh config.",
                        });
                      }
                    },
                  )
                }
              >
                {busyAction === "Create Vault" ? "Submitting..." : activeVaultId ? "Vault already created" : "Create Vault"}
              </button>

              <input
                className="input input-bordered w-full"
                value={depositAmount}
                onChange={event => setDepositAmount(event.target.value)}
                placeholder="Deposit amount"
              />
              <button
                className="btn btn-primary"
                disabled={busyAction !== null || !activeVaultId || appConfig.coinType !== SUI_COIN_TYPE}
                onClick={() =>
                  runTransaction("Deposit to Vault", tx => {
                    const amount = parseAmountInput(depositAmount, appConfig.coinDecimals);
                    const [coin] = tx.splitCoins(tx.gas, [amount]);
                    tx.moveCall({
                      target: `${vaultTargetBase}::deposit`,
                      typeArguments: [appConfig.coinType],
                      arguments: [tx.object(activeVaultId), coin],
                    });
                  })
                }
              >
                {busyAction === "Deposit to Vault" ? "Submitting..." : "Deposit to Vault"}
              </button>

              <div className="grid gap-3 md:grid-cols-2">
                <input
                  className="input input-bordered w-full"
                  value={withdrawAmount}
                  onChange={event => setWithdrawAmount(event.target.value)}
                  placeholder="Withdraw amount"
                />
                <input
                  className="input input-bordered w-full"
                  value={withdrawRecipient}
                  onChange={event => setWithdrawRecipient(event.target.value)}
                  placeholder="Recipient address"
                />
              </div>
              <button
                className="btn btn-outline"
                disabled={busyAction !== null || !activeVaultId}
                onClick={() =>
                  runTransaction("Withdraw from Vault", tx => {
                    const amount = parseAmountInput(withdrawAmount, appConfig.coinDecimals);
                    tx.moveCall({
                      target: `${vaultTargetBase}::withdraw`,
                      typeArguments: [appConfig.coinType],
                      arguments: [
                        tx.object(activeVaultId),
                        tx.pure.u64(amount.toString()),
                        tx.pure.address(withdrawRecipient || account?.address || ZERO_ADDRESS),
                      ],
                    });
                  })
                }
              >
                {busyAction === "Withdraw from Vault" ? "Submitting..." : "Withdraw from Vault"}
              </button>

              <div className="grid gap-3 md:grid-cols-2">
                <button
                  className="btn btn-secondary"
                  disabled={busyAction !== null || !activeVaultId}
                  onClick={() =>
                    runTransaction("Pause Vault", tx => {
                      tx.moveCall({
                        target: `${vaultTargetBase}::pause`,
                        typeArguments: [appConfig.coinType],
                        arguments: [tx.object(activeVaultId)],
                      });
                    })
                  }
                >
                  {busyAction === "Pause Vault" ? "Submitting..." : "Pause Vault"}
                </button>
                <button
                  className="btn btn-outline"
                  disabled={busyAction !== null || !activeVaultId}
                  onClick={() =>
                    runTransaction("Resume Vault", tx => {
                      tx.moveCall({
                        target: `${vaultTargetBase}::unpause`,
                        typeArguments: [appConfig.coinType],
                        arguments: [tx.object(activeVaultId)],
                      });
                    })
                  }
                >
                  {busyAction === "Resume Vault" ? "Submitting..." : "Resume Vault"}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">3. Session Key Authorization</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Owner grants limits, validity period, and optional recipient constraint to the executing wallet.
                </p>
              </div>
              <span className="badge badge-outline">Policy</span>
            </div>

            <div className="mt-5 space-y-3">
              <label className="form-control w-full gap-2">
                <span className="text-sm font-medium text-base-content/75">Session key address</span>
                <input
                  className="input input-bordered w-full"
                  value={sessionKeyAddress}
                  onChange={event => setSessionKeyAddress(event.target.value)}
                  placeholder="Wallet address for signing execute_payment"
                />
              </label>
              <button className="btn btn-outline" type="button" onClick={generateSessionKey}>
                Generate session key
              </button>
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
                <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                  <label className="form-control w-full gap-2">
                    <span className="text-sm font-medium text-base-content/75">Session key gas top-up</span>
                    <input
                      className="input input-bordered w-full"
                      value={sessionGasAmount}
                      onChange={event => setSessionGasAmount(event.target.value)}
                      placeholder={`Amount of ${appConfig.coinSymbol} to send for gas`}
                    />
                  </label>
                  <button
                    className="btn btn-outline self-end"
                    disabled={busyAction !== null || !sessionKeyAddress}
                    onClick={() =>
                      runTransaction("Fund Session Key Gas", tx => {
                        const topUpAmount = parseAmountInput(sessionGasAmount, appConfig.coinDecimals);
                        const [topUpCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(topUpAmount.toString())]);
                        tx.transferObjects([topUpCoin], tx.pure.address(sessionKeyAddress));
                      })
                    }
                  >
                    {busyAction === "Fund Session Key Gas" ? "Submitting..." : "Fund Session Key Gas"}
                  </button>
                </div>
                <p className="mb-0 mt-3 text-xs leading-6 text-base-content/55">
                  `execute_payment` is signed by the session key, so the session key address must hold a small amount of
                  {` ${appConfig.coinSymbol} `}for gas unless you add sponsored transaction support.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="form-control w-full gap-2">
                  <span className="text-sm font-medium text-base-content/75">Max per transaction</span>
                  <input
                    className="input input-bordered w-full"
                    value={maxPerTx}
                    onChange={event => setMaxPerTx(event.target.value)}
                    placeholder={`Max payment per transaction in ${appConfig.coinSymbol}`}
                  />
                </label>
                <label className="form-control w-full gap-2">
                  <span className="text-sm font-medium text-base-content/75">Total budget</span>
                  <input
                    className="input input-bordered w-full"
                    value={maxTotal}
                    onChange={event => setMaxTotal(event.target.value)}
                    placeholder={`Max total payment for this session key in ${appConfig.coinSymbol}`}
                  />
                </label>
              </div>
              <label className="form-control w-full gap-2">
                <span className="text-sm font-medium text-base-content/75">Approval threshold</span>
                <input
                  className="input input-bordered w-full"
                  value={approvalThreshold}
                  onChange={event => setApprovalThreshold(event.target.value)}
                  placeholder={`Payments above this amount trigger Telegram approval in ${appConfig.coinSymbol}`}
                />
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="form-control w-full gap-2">
                  <span className="text-sm font-medium text-base-content/75">Validity (hours)</span>
                  <input
                    className="input input-bordered w-full"
                    value={expiryHours}
                    onChange={event => setExpiryHours(event.target.value)}
                    placeholder="Number of hours from now until expiry"
                  />
                </label>
                <label className="form-control w-full gap-2">
                  <span className="text-sm font-medium text-base-content/75">Allowed recipient</span>
                  <input
                    className="input input-bordered w-full"
                    value={allowedRecipient}
                    onChange={event => setAllowedRecipient(event.target.value)}
                    placeholder="Leave empty for no restriction"
                  />
                </label>
              </div>
              <p className="text-xs leading-6 text-base-content/55">
                Defaults: max per tx `0.1 {appConfig.coinSymbol}`, total budget `1 {appConfig.coinSymbol}`, validity `24` hours.
                Telegram approval triggers when payment amount is above the approval threshold but still within the per-tx limit.
                After expiry, the runtime now blocks direct payment, contract call, and DeepBook execution until you rotate the key.
              </p>
              <button
                className="btn btn-primary"
                disabled={busyAction !== null || !activeVaultId}
                onClick={() =>
                  runTransaction("Register Session Key", tx => {
                    const maxPerTxValue = parseAmountInput(maxPerTx, appConfig.coinDecimals);
                    const maxTotalValue = parseAmountInput(maxTotal, appConfig.coinDecimals);
                    const expiryMs = BigInt(Date.now() + Number(expiryHours || "0") * 60 * 60 * 1000);

                    tx.moveCall({
                      target: `${vaultTargetBase}::register_session_key`,
                      typeArguments: [appConfig.coinType],
                      arguments: [
                        tx.object(activeVaultId),
                        tx.pure.address(sessionKeyAddress),
                        tx.pure.u64(maxPerTxValue.toString()),
                        tx.pure.u64(maxTotalValue.toString()),
                        tx.pure.u64(expiryMs.toString()),
                        tx.pure.address(allowedRecipient || ZERO_ADDRESS),
                        tx.object.clock(),
                      ],
                    });
                  })
                }
              >
                {busyAction === "Register Session Key" ? "Submitting..." : "Register Session Key"}
              </button>
            </div>
          </div>

        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-lg font-bold">Runtime Snapshot</p>
              <p className="mt-1 text-sm text-base-content/55">
                Runtime status, latest local agents, and recent audit activity.
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void refreshBackend()}>
              {backendBusyAction === "refresh" ? "Loading..." : "Refresh"}
            </button>
          </div>

          {backendStatus ? (
            <div className="mt-5 space-y-4 text-sm">
              {(expiredBackendAgents.length > 0 || expiringSoonBackendAgents.length > 0) && (
                <div className="space-y-3">
                  {expiredBackendAgents.length > 0 && (
                    <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="m-0 text-sm font-semibold">Expired session keys detected</p>
                          <p className="mt-1 text-xs text-base-content/65">
                            Recover assets first, then revoke the old key on-chain and rotate to a replacement key.
                          </p>
                        </div>
                        <span className="badge badge-warning">{expiredBackendAgents.length}</span>
                      </div>
                      <div className="mt-3 space-y-3">
                        {expiredBackendAgents.map(agent => (
                          <div key={agent.agentId} className="rounded-2xl border border-warning/20 bg-base-100/80 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="m-0 text-sm font-semibold">{agent.label}</p>
                                <p className="mt-1 text-xs text-base-content/60">
                                  {agent.session?.expiry
                                    ? `${new Date(agent.session.expiry * 1000).toLocaleString("en-US")} / ${formatExpiryStatus(agent.session.expiry)}`
                                    : "Session expiry unavailable"}
                                </p>
                                <p className="mt-2 break-all font-mono text-[11px] text-base-content/55">{agent.sessionKey}</p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  className="btn btn-ghost btn-xs"
                                  onClick={() => void inspectSessionAssets(agent)}
                                >
                                  {backendBusyAction === `inspect-session-${agent.agentId}` ? "Loading..." : "Inspect assets"}
                                </button>
                                <button
                                  className="btn btn-outline btn-xs"
                                  onClick={() => void recoverSessionAssets(agent)}
                                >
                                  {backendBusyAction === `recover-session-${agent.agentId}` ? "Recovering..." : "Recover assets"}
                                </button>
                                <button className="btn btn-outline btn-xs" onClick={() => revokeSessionKeyOnChain(agent)}>
                                  Revoke on-chain
                                </button>
                                <button className="btn btn-primary btn-xs" onClick={() => prepareRotationForAgent(agent)}>
                                  Prepare rotation
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {expiringSoonBackendAgents.length > 0 && (
                    <div className="rounded-2xl border border-info/30 bg-info/10 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="m-0 text-sm font-semibold">Session keys expiring soon</p>
                          <p className="mt-1 text-xs text-base-content/65">
                            Prepare the replacement key before the current session expires to avoid demo downtime.
                          </p>
                        </div>
                        <span className="badge badge-info">{expiringSoonBackendAgents.length}</span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {expiringSoonBackendAgents.map(agent => (
                          <div key={agent.agentId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-info/20 bg-base-100/80 px-4 py-3">
                            <div>
                              <p className="m-0 text-sm font-semibold">{agent.label}</p>
                              <p className="mt-1 text-xs text-base-content/60">
                                {agent.session?.expiry
                                  ? `${new Date(agent.session.expiry * 1000).toLocaleString("en-US")} / ${formatExpiryStatus(agent.session.expiry)}`
                                  : "Session expiry unavailable"}
                              </p>
                            </div>
                            <button className="btn btn-primary btn-xs" onClick={() => prepareRotationForAgent(agent)}>
                              Prepare rotation
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Storage</p>
                  <p className="mt-2 font-mono">{backendStatus.storageMode}</p>
                </div>
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs text-base-content/45">Agents</p>
                  <p className="mt-2 text-lg font-bold">{backendStatus.counts.agents}</p>
                </div>
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs text-base-content/45">Receipts</p>
                  <p className="mt-2 text-lg font-bold">{backendStatus.counts.recentReceipts}</p>
                </div>
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs text-base-content/45">Services</p>
                  <p className="mt-2 text-lg font-bold">{backendStatus.counts.paidServices}</p>
                </div>
              </div>
              <div className="rounded-2xl bg-base-200 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">DB Path</p>
                <p className="mt-2 break-all font-mono text-xs">{backendStatus.dbPath}</p>
              </div>
              <div className="grid gap-4 2xl:grid-cols-2">
                <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="m-0 text-sm font-semibold">Local Agents</p>
                    {backendAgents.length > 1 && <span className="text-xs text-base-content/45">{backendAgents.length} total</span>}
                  </div>
                  <div className="mt-3 space-y-3">
                    {latestBackendAgent ? (
                      <>
                        <article className="rounded-2xl border border-base-300 bg-base-100 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="m-0 text-sm font-bold">{latestBackendAgent.label}</p>
                              <p className="mt-1 text-xs text-base-content/50">
                                {latestBackendAgent.agentType} / {latestBackendAgent.userId}
                              </p>
                            </div>
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() => {
                                loadAgentIntoForm(latestBackendAgent);
                              }}
                            >
                              Use
                            </button>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {latestBackendAgent.revokedAt ? (
                              <span className="badge badge-warning badge-outline">Revoked</span>
                            ) : latestBackendAgent.session?.expiry ? (
                              <span
                                className={`badge badge-outline ${
                                  latestBackendAgent.session.expiry <= nowSeconds
                                    ? "badge-warning"
                                    : latestBackendAgent.session.expiry - nowSeconds <= 6 * 60 * 60
                                      ? "badge-info"
                                      : "badge-success"
                                }`}
                              >
                                {formatExpiryStatus(latestBackendAgent.session.expiry)}
                              </span>
                            ) : null}
                          </div>
                          <p className="mb-0 mt-3 break-all font-mono text-xs text-base-content/60">{latestBackendAgent.agentId}</p>
                          <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/60">{latestBackendAgent.sessionKey}</p>
                        </article>
                        {olderBackendAgents.length > 0 && (
                          <details className="rounded-2xl border border-base-300 bg-base-100">
                            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-base-content/70">
                              Show {olderBackendAgents.length} older agent{olderBackendAgents.length > 1 ? "s" : ""}
                            </summary>
                            <div className="space-y-3 border-t border-base-300 px-4 py-4">
                              {olderBackendAgents.map(agent => (
                                <article key={agent.agentId} className="rounded-2xl border border-base-300 bg-base-200 p-4">
                                  <p className="m-0 text-sm font-bold">{agent.label}</p>
                                  <p className="mt-1 text-xs text-base-content/50">{agent.agentType} / {agent.userId}</p>
                                  {agent.session?.expiry && (
                                    <p className="mt-2 text-[11px] text-base-content/55">{formatExpiryStatus(agent.session.expiry)}</p>
                                  )}
                                  <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/60">{agent.agentId}</p>
                                </article>
                              ))}
                            </div>
                          </details>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-base-content/45">No agents in the runtime yet.</p>
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="m-0 text-sm font-semibold">Recent Audit</p>
                    {backendReceipts.length > 1 && <span className="text-xs text-base-content/45">{backendReceipts.length} total</span>}
                  </div>
                  <div className="mt-3 space-y-3">
                    {latestBackendReceipt ? (
                      <>
                        <article className="rounded-2xl border border-base-300 bg-base-100 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <p className="m-0 text-sm font-bold">{latestBackendReceipt.result}</p>
                            <span className="text-[11px] text-base-content/45">
                              {new Date(latestBackendReceipt.timestamp).toLocaleString("en-US")}
                            </span>
                          </div>
                          <p className="mb-0 mt-2 text-sm text-base-content/70">{latestBackendReceipt.reason}</p>
                          <p className="mb-0 mt-2 text-xs text-base-content/55">
                            {latestBackendReceipt.agentId} / {latestBackendReceipt.operation ?? "payment"} /{" "}
                            {formatAmount(latestBackendReceipt.amount, appConfig.coinDecimals, appConfig.coinSymbol)}
                          </p>
                        </article>
                        {olderBackendReceipts.length > 0 && (
                          <details className="rounded-2xl border border-base-300 bg-base-100">
                            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-base-content/70">
                              Show {olderBackendReceipts.length} older receipt{olderBackendReceipts.length > 1 ? "s" : ""}
                            </summary>
                            <div className="space-y-3 border-t border-base-300 px-4 py-4">
                              {olderBackendReceipts.map(receipt => (
                                <article key={receipt.paymentId} className="rounded-2xl border border-base-300 bg-base-200 p-4">
                                  <p className="m-0 text-sm font-bold">{receipt.result}</p>
                                  <p className="mb-0 mt-2 text-sm text-base-content/70">{receipt.reason}</p>
                                </article>
                              ))}
                            </div>
                          </details>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-base-content/45">No receipts in the runtime yet.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-5 text-sm text-base-content/45">Backend not connected.</p>
          )}

          {!!backendError && (
            <div className="mt-4 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-base-content/75">
              {backendError}
            </div>
          )}
        </div>

        <div className="grid content-start gap-6 lg:grid-cols-2">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">5. Sync Agent to Runtime</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Write the local agent config and session signer into the runtime backend to get a usable `agentId`.
                </p>
              </div>
              <span className="badge badge-outline">Runtime</span>
            </div>
            <div className="mt-5 space-y-3">
              <div className="grid gap-3 md:grid-cols-2">
                <select
                  className="select select-bordered w-full"
                  value={backendAgentType}
                  onChange={event => setBackendAgentType(event.target.value as "long_lived" | "temporary")}
                >
                  <option value="long_lived">long_lived</option>
                  <option value="temporary">temporary</option>
                </select>
                <input
                  className="input input-bordered w-full"
                  value={backendUserId}
                  onChange={event => setBackendUserId(event.target.value)}
                  placeholder="User ID"
                />
              </div>
              <input
                className="input input-bordered w-full"
                value={sdkSessionKey}
                onChange={event => setSdkSessionKey(event.target.value)}
                placeholder="Session private key stored only in local runtime"
              />
              <button className="btn btn-primary" onClick={() => void syncAgentToRuntime()}>
                {backendBusyAction === "sync-agent" ? "Syncing..." : "Sync to local runtime"}
              </button>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">6. Telegram Bindings</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Save a default Telegram chat ID for each wallet address used in the approval demo.
                </p>
              </div>
              <span className="badge badge-outline">{backendTelegramBindings.length} saved</span>
            </div>
            <div className="mt-5 space-y-3">
              <input
                className="input input-bordered w-full"
                value={approvalChatId}
                onChange={event => setApprovalChatId(event.target.value)}
                placeholder="Telegram chat ID"
              />
              <div className="flex flex-wrap gap-3">
                <button className="btn btn-primary" onClick={() => void saveTelegramBinding()}>
                  {backendBusyAction === "save-tg-binding" ? "Saving..." : currentWalletBinding ? "Update binding" : "Save binding"}
                </button>
                {currentWalletBinding && (
                  <button className="btn btn-outline" onClick={() => void deleteTelegramBinding(currentWalletBinding.walletAddress)}>
                    {backendBusyAction === "delete-tg-binding" ? "Removing..." : "Remove current binding"}
                  </button>
                )}
              </div>
              {currentWalletBinding && (
                <div className="rounded-2xl bg-base-200 p-4 text-xs text-base-content/65">
                  <p className="m-0 uppercase tracking-[0.22em] text-base-content/40">Current Binding</p>
                  <p className="mt-2 break-all font-mono">{currentWalletBinding.walletAddress}</p>
                  <p className="mt-2 break-all font-mono">{currentWalletBinding.chatId}</p>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20 lg:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">7. Contract Whitelist</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Package IDs saved here can be executed by the agent without Telegram approval for this wallet.
                </p>
              </div>
              <span className="badge badge-outline">{currentWalletContractWhitelist.length} saved</span>
            </div>
            <div className="mt-5 space-y-3">
              <input
                className="input input-bordered w-full"
                value={whitelistPackageId}
                onChange={event => setWhitelistPackageId(event.target.value)}
                placeholder="Package ID to whitelist"
              />
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <input
                  className="input input-bordered w-full"
                  value={whitelistLabel}
                  onChange={event => setWhitelistLabel(event.target.value)}
                  placeholder="Optional label"
                />
                <button className="btn btn-primary" onClick={() => void saveContractWhitelistEntry()}>
                  {backendBusyAction === "save-contract-whitelist" ? "Saving..." : "Save"}
                </button>
              </div>
              {currentWalletContractWhitelist.length > 0 ? (
                <details className="rounded-2xl border border-base-300 bg-base-200">
                  <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-base-content/70">
                    Show {currentWalletContractWhitelist.length} whitelist entr{currentWalletContractWhitelist.length > 1 ? "ies" : "y"}
                  </summary>
                  <div className="space-y-3 border-t border-base-300 px-4 py-4">
                    {currentWalletContractWhitelist.map(entry => (
                      <div key={entry.entryId} className="rounded-2xl border border-base-300 bg-base-100 p-3 text-xs text-base-content/70">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="m-0 break-all font-mono">{entry.packageId}</p>
                            {entry.label && <p className="mb-0 mt-2 text-sm font-medium text-base-content/75">{entry.label}</p>}
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="btn btn-ghost btn-xs"
                              onClick={() => {
                                setWhitelistPackageId(entry.packageId);
                                setWhitelistLabel(entry.label ?? "");
                                setContractPackageId(entry.packageId);
                              }}
                            >
                              Use
                            </button>
                            <button
                              className="btn btn-ghost btn-xs text-error"
                              onClick={() => void deleteContractWhitelistEntry(entry.packageId)}
                            >
                              {backendBusyAction === "delete-contract-whitelist" ? "Removing..." : "Remove"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ) : (
                <p className="m-0 text-sm text-base-content/45">No whitelisted contract packages for the current wallet yet.</p>
              )}
            </div>
          </div>
        </div>

        <div className="grid content-start gap-6 xl:col-span-2 2xl:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20 2xl:col-span-2">
            <p className="text-lg font-bold">8. Contract Call Console</p>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4 text-sm text-base-content/70">
                <p className="m-0 font-semibold">Move call demo</p>
                <p className="mb-0 mt-2">
                  The runtime signs a generic Move call with the selected session key. Whitelisted package IDs execute directly. Any other package creates a Telegram approval request first.
                </p>
                <p className="mb-0 mt-2 text-xs leading-6 text-base-content/60">
                  This path uses the session key wallet for gas. If the Move function also needs coins or owned objects, pass them explicitly in the argument JSON.
                </p>
              </div>

              <select
                className="select select-bordered w-full"
                value={sdkAgentId}
                onChange={event => setSdkAgentId(event.target.value)}
              >
                <option value="">Select an Agent</option>
                {runnableBackendAgents.map(agent => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.label}
                  </option>
                ))}
              </select>

              <input
                className="input input-bordered w-full"
                value={contractCallReason}
                onChange={event => setContractCallReason(event.target.value)}
                placeholder="Reason for this contract call"
              />
              <input
                className="input input-bordered w-full"
                value={contractPackageId}
                onChange={event => setContractPackageId(event.target.value)}
                placeholder="Package ID"
              />
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  className="input input-bordered w-full"
                  value={contractModule}
                  onChange={event => setContractModule(event.target.value)}
                  placeholder="Module"
                />
                <input
                  className="input input-bordered w-full"
                  value={contractFunctionName}
                  onChange={event => setContractFunctionName(event.target.value)}
                  placeholder="Function"
                />
              </div>
              <textarea
                className="textarea textarea-bordered min-h-[72px] w-full"
                value={contractTypeArguments}
                onChange={event => setContractTypeArguments(event.target.value)}
                placeholder='["0x2::sui::SUI"]'
              />
              <textarea
                className="textarea textarea-bordered min-h-[132px] w-full font-mono text-xs"
                value={contractArgumentsJson}
                onChange={event => setContractArgumentsJson(event.target.value)}
                placeholder='[{"kind":"u64","value":"1"}]'
              />
              <p className="text-xs leading-6 text-base-content/55">
                Supported argument kinds: `object`, `address`, `u64`, `string`, `bool`.
              </p>
              <pre className="overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
                {contractCallRequestExample}
              </pre>
              <button className="btn btn-primary" onClick={() => void submitContractCall()}>
                {backendBusyAction === "contract-call" ? "Submitting..." : "Run contract call"}
              </button>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20 2xl:col-span-2">
            <p className="text-lg font-bold">9. Mock Agent Console</p>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4 text-sm text-base-content/70">
                <p className="m-0 font-semibold">Minimal demo</p>
                <p className="mb-0 mt-2">
                  Give the mock agent a natural-language wallet instruction. It can parse a token transfer, a DeepBook swap, or a contract call, then execute it through the runtime wallet using `agentId`.
                </p>
                <p className="mb-0 mt-2 text-xs leading-6 text-base-content/60">
                  {"Examples: `Swap 0.01 SUI to USDC via DeepBook` / `Pay 0.01 SUI to 0x... for API usage` / `Call 0x...::module::function type args [\"0x2::sui::SUI\"] args [{\"kind\":\"u64\",\"value\":\"1\"}]`"}
                </p>
              </div>

              <select
                className="select select-bordered w-full"
                value={sdkAgentId}
                onChange={event => setSdkAgentId(event.target.value)}
              >
                <option value="">Select an Agent</option>
                {runnableBackendAgents.map(agent => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.label}
                  </option>
                ))}
              </select>

              <div className="rounded-2xl bg-base-200 p-4 text-xs text-base-content/65">
                <p className="m-0 uppercase tracking-[0.22em] text-base-content/40">Endpoint</p>
                <p className="mt-2 break-all font-mono">/api/mock-agent/pay</p>
                <p className="mt-3 m-0 uppercase tracking-[0.22em] text-base-content/40">Selected Agent</p>
                <p className="mt-2 break-all font-mono">{selectedBackendAgent?.agentId || "Not selected"}</p>
                <p className="mt-3 m-0 uppercase tracking-[0.22em] text-base-content/40">Bound Wallet</p>
                <p className="mt-2 break-all font-mono">{account?.address || "Connect wallet to bind the approval context"}</p>
              </div>

              <input
                className="input input-bordered w-full"
                value={approvalChatId}
                onChange={event => setApprovalChatId(event.target.value)}
                placeholder="Telegram chat ID for approval"
              />
              <p className="text-xs leading-6 text-base-content/55">
                Uses the saved binding for the current wallet by default. You can still override it for a single request here.
              </p>
              <textarea
                className="textarea textarea-bordered min-h-[110px] w-full"
                value={mockAgentInstruction}
                onChange={event => setMockAgentInstruction(event.target.value)}
                placeholder='Swap 0.01 SUI to USDC via DeepBook or Call 0x...::module::function args [{"kind":"u64","value":"1"}]'
              />
              <pre className="overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
                {mockAgentRequestExample}
              </pre>
              <button className="btn btn-primary" onClick={() => void submitMockAgentInstruction()}>
                {backendBusyAction === "mock-agent" ? "Processing..." : "Run mock agent"}
              </button>

              {trackedApprovalToken && (
                <div className="rounded-2xl border border-base-300 bg-base-200 p-4 text-sm text-base-content/75">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="m-0 font-semibold">Latest approval flow</p>
                    <span
                      className={`badge ${
                        trackedApproval?.status === "executed"
                          ? "badge-success"
                          : trackedApproval?.status === "failed"
                            ? "badge-error"
                            : trackedApproval?.status === "rejected"
                              ? "badge-warning"
                              : "badge-info"
                      }`}
                    >
                      {trackedApproval?.status ?? "pending"}
                    </span>
                  </div>
                  <p className="mb-0 mt-2 text-xs text-base-content/55">
                    {trackedApprovalPending
                      ? "Waiting for Telegram approval. Status refreshes every 3 seconds."
                      : "Telegram callback has been processed by the local runtime."}
                  </p>
                  <div className="mt-3 space-y-2 text-xs">
                    <p className="m-0">
                      <span className="text-base-content/45">Approval token</span>
                    </p>
                    <p className="m-0 break-all font-mono">{trackedApprovalToken}</p>
                    {trackedApproval?.txHash && (
                      <>
                        <p className="m-0 pt-1">
                          <span className="text-base-content/45">Transaction</span>
                        </p>
                        <p className="m-0 break-all font-mono">{trackedApproval.txHash}</p>
                      </>
                    )}
                    {latestTelegramApproval?.sent === true && latestTelegramApproval.approveUrl && (
                      <>
                        <p className="m-0 pt-1">
                          <span className="text-base-content/45">Approve URL</span>
                        </p>
                        <p className="m-0 break-all font-mono">{latestTelegramApproval.approveUrl}</p>
                      </>
                    )}
                    {latestTelegramApproval?.sent === false && (
                      <p className="m-0 text-error">
                        Telegram send failed: {latestTelegramApproval.error}
                        {latestTelegramApproval.details ? ` (${latestTelegramApproval.details})` : ""}
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="divider my-1 text-xs text-base-content/35">Direct Runtime Payment</div>

              <input
                className="input input-bordered w-full"
                value={sdkPaymentReason}
                onChange={event => setSdkPaymentReason(event.target.value)}
                placeholder="Payment reason"
              />
              <input
                className="input input-bordered w-full"
                value={sdkPaymentAmount}
                onChange={event => setSdkPaymentAmount(event.target.value)}
                placeholder="Payment amount"
              />
              <pre className="overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
                {runtimePayRequestExample}
              </pre>
              <button className="btn btn-outline" onClick={() => void submitRuntimePayment()}>
                {backendBusyAction === "sdk-payment" ? "Submitting..." : "Run direct runtime payment"}
              </button>
            </div>
          </div>
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <p className="text-lg font-bold">10. x402 / Receipt Verify</p>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl bg-base-200 p-4 text-xs text-base-content/65">
                <p className="m-0 uppercase tracking-[0.22em] text-base-content/40">Endpoint</p>
                <p className="mt-2 break-all font-mono">{runtimeX402Endpoint}</p>
              </div>
              <input
                className="input input-bordered w-full"
                value={x402Url}
                onChange={event => setX402Url(event.target.value)}
                placeholder="x402 URL"
              />
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  className="input input-bordered w-full"
                  value={x402Method}
                  onChange={event => setX402Method(event.target.value)}
                  placeholder="Method"
                />
                <input
                  className="input input-bordered w-full"
                  value={x402Reason}
                  onChange={event => setX402Reason(event.target.value)}
                  placeholder="Reason"
                />
              </div>
              <textarea
                className="textarea textarea-bordered min-h-[72px] w-full"
                value={x402Body}
                onChange={event => setX402Body(event.target.value)}
                placeholder="Optional request body"
              />
              <pre className="overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
                {runtimeX402RequestExample}
              </pre>
              <button className="btn btn-outline" onClick={() => void submitRuntimeX402()}>
                {backendBusyAction === "x402-request" ? "Submitting..." : "Execute Agent x402 Request"}
              </button>

              <div className="divider my-1 text-xs text-base-content/35">Verify Receipt</div>

              <select
                className="select select-bordered w-full"
                value={verifyServiceId}
                onChange={event => setVerifyServiceId(event.target.value)}
              >
                <option value="">Select service</option>
                {backendServices.map(service => (
                  <option key={service.serviceId} value={service.serviceId}>
                    {service.description}
                  </option>
                ))}
              </select>
              <textarea
                className="textarea textarea-bordered min-h-[72px] w-full"
                value={verifyReceiptHeader}
                onChange={event => setVerifyReceiptHeader(event.target.value)}
                placeholder="x-payment-receipt header"
              />
              <button className="btn btn-outline" onClick={() => void verifyReceipt()}>
                {backendBusyAction === "verify-receipt" ? "Verifying..." : "Verify Receipt"}
              </button>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-bold">Response Inspector</p>
              <span className="text-xs text-base-content/45">Latest payload</span>
            </div>
            <div className="mt-4 space-y-3">
              {latestBackendService && (
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Latest Service</p>
                  <p className="mt-3 text-sm font-semibold">{latestBackendService.description}</p>
                  <p className="mt-2 break-all font-mono text-xs text-base-content/65">{latestBackendService.serviceId}</p>
                  {olderBackendServices.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer list-none text-xs font-medium text-base-content/60">
                        Show {olderBackendServices.length} older service{olderBackendServices.length > 1 ? "s" : ""}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {olderBackendServices.map(service => (
                          <div key={service.serviceId} className="text-xs text-base-content/65">
                            <p className="m-0 font-semibold">{service.description}</p>
                            <p className="m-0 break-all font-mono">{service.serviceId}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              {latestBackendApproval && (
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Latest Approval</p>
                  <p className="mt-3 text-sm font-semibold">
                    {latestBackendApproval.status} / {latestBackendApproval.channel} / {latestBackendApproval.operation ?? "payment"}
                  </p>
                  <p className="mt-2 text-xs text-base-content/65">{latestBackendApproval.reason}</p>
                  <p className="mt-2 break-all font-mono text-xs text-base-content/65">{latestBackendApproval.recipient}</p>
                  {latestBackendApproval.contractCall?.target && (
                    <p className="mt-2 break-all font-mono text-xs text-base-content/65">{latestBackendApproval.contractCall.target}</p>
                  )}
                  {olderBackendApprovals.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer list-none text-xs font-medium text-base-content/60">
                        Show {olderBackendApprovals.length} older approval{olderBackendApprovals.length > 1 ? "s" : ""}
                      </summary>
                      <div className="mt-2 space-y-2">
                        {olderBackendApprovals.map(approval => (
                          <div key={approval.approvalId} className="text-xs text-base-content/65">
                            <p className="m-0 font-semibold">
                              {approval.status} / {approval.channel} / {approval.operation ?? "payment"}
                            </p>
                            <p className="m-0">{approval.reason}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              <pre className="max-h-[320px] overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
                {backendResult || "Run an action to see the SDK / x402 response here."}
              </pre>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default dynamic(async () => DashboardPageContent, { ssr: false });

"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
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
  reason: string;
  recipient: string;
  amount: string;
  result: string;
  finalDecision: string;
  txHash?: string;
  timestamp: string;
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
};

type BackendTelegramBinding = {
  bindingId: string;
  walletAddress: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
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
  const [backendResult, setBackendResult] = useState("");
  const [trackedApprovalToken, setTrackedApprovalToken] = useState("");
  const [trackedApproval, setTrackedApproval] = useState<BackendApproval | null>(null);
  const [latestTelegramApproval, setLatestTelegramApproval] = useState<MockAgentResponse["telegram"] | null>(null);
  const [sdkAgentId, setSdkAgentId] = useState("");
  const [sdkSessionKey, setSdkSessionKey] = useState("");
  const [sdkPaymentReason, setSdkPaymentReason] = useState("agent runtime payment");
  const [sdkPaymentAmount, setSdkPaymentAmount] = useState("0.01");
  const [approvalChatId, setApprovalChatId] = useState("");
  const [mockAgentInstruction, setMockAgentInstruction] = useState(
    "Pay 0.01 SUI to 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef for API usage",
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
  const runnableBackendAgents = backendAgents.filter(agent => agent.hasStoredSessionKey && !agent.revokedAt);
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

  async function refreshBackend() {
    setBackendBusyAction("refresh");
    setBackendError("");

    try {
      const [status, agents, receipts, services, approvals, telegramBindings] = await Promise.all([
        apiRequest<BackendStatus>("/api/backend/status"),
        apiRequest<BackendAgent[]>("/api/agents?includeSession=true"),
        apiRequest<BackendReceipt[]>("/api/audit-log?limit=12"),
        apiRequest<BackendService[]>("/api/services"),
        apiRequest<BackendApproval[]>("/api/approvals?limit=12"),
        apiRequest<BackendTelegramBinding[]>("/api/tg-bindings"),
      ]);

      setBackendStatus(status);
      setBackendAgents(agents);
      setBackendReceipts(receipts);
      setBackendServices(services);
      setBackendApprovals(approvals);
      setBackendTelegramBindings(telegramBindings);
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

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
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
                <p className="text-lg font-bold">3. Vault Fund Operations</p>
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
                <p className="text-lg font-bold">4. Session Key Authorization</p>
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

      <section className="grid gap-6 xl:grid-cols-[0.9fr_1.05fr_1.05fr]">
        <div className="space-y-6">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">5. Runtime Status</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Next.js API route with JSON runtime storage, audit, and x402 support for the agent backend.
                </p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => void refreshBackend()}>
                {backendBusyAction === "refresh" ? "Loading..." : "Refresh"}
              </button>
            </div>

            {backendStatus ? (
              <div className="mt-5 space-y-3 text-sm">
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Storage</p>
                  <p className="mt-2 font-mono">{backendStatus.storageMode}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
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

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">6. Sync Agent to Runtime</p>
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
              <p className="text-xs leading-6 text-base-content/55">
                The private key is only saved in the runtime backend for this demo. Read endpoints never return it.
              </p>
              <button className="btn btn-primary" onClick={() => void syncAgentToRuntime()}>
                {backendBusyAction === "sync-agent" ? "Syncing..." : "Sync to local runtime"}
              </button>
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold">7. Telegram Bindings</p>
                <p className="mt-1 text-sm text-base-content/55">
                  Save a default Telegram chat ID for each wallet address used in the approval demo.
                </p>
              </div>
              <span className="badge badge-outline">{backendTelegramBindings.length} saved</span>
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl bg-base-200 p-4 text-xs text-base-content/65">
                <p className="m-0 uppercase tracking-[0.22em] text-base-content/40">Current Wallet</p>
                <p className="mt-2 break-all font-mono">{account?.address || "Connect wallet to manage bindings"}</p>
              </div>

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

              <div className="rounded-2xl border border-base-300 bg-base-200 p-4">
                <p className="m-0 text-xs uppercase tracking-[0.22em] text-base-content/40">Binding Table</p>
                <div className="mt-3 space-y-3">
                  {backendTelegramBindings.length > 0 ? (
                    backendTelegramBindings.map(binding => (
                      <div key={binding.bindingId} className="rounded-2xl border border-base-300 bg-base-100 p-3 text-xs text-base-content/70">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="m-0 break-all font-mono">{binding.walletAddress}</p>
                            <p className="mb-0 mt-2 break-all font-mono">{binding.chatId}</p>
                            <p className="mb-0 mt-2 text-[11px] text-base-content/45">
                              Updated {new Date(binding.updatedAt).toLocaleString("en-US")}
                            </p>
                          </div>
                          <button className="btn btn-ghost btn-xs" onClick={() => setApprovalChatId(binding.chatId)}>
                            Use
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="m-0 text-sm text-base-content/45">No Telegram bindings saved yet.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-bold">Local Agents</p>
              {backendAgents.length > 1 && <span className="text-xs text-base-content/45">{backendAgents.length} total</span>}
            </div>
            <div className="mt-4 space-y-3">
              {latestBackendAgent ? (
                <>
                  <article className="rounded-2xl border border-base-300 bg-base-200 p-4">
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
                          setSdkAgentId(latestBackendAgent.agentId);
                          setSessionKeyAddress(latestBackendAgent.sessionKey);
                        }}
                      >
                        Use
                      </button>
                    </div>
                    <p className="mb-0 mt-3 break-all font-mono text-xs text-base-content/60">{latestBackendAgent.agentId}</p>
                    <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/60">{latestBackendAgent.sessionKey}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
                      <span
                        className={`badge badge-sm ${latestBackendAgent.hasStoredSessionKey ? "badge-success" : "badge-ghost"}`}
                      >
                        {latestBackendAgent.hasStoredSessionKey ? "runtime ready" : "missing signer"}
                      </span>
                      {latestBackendAgent.revokedAt && <span className="badge badge-sm badge-error">revoked</span>}
                    </div>
                    {latestBackendAgent.session && (
                      <p className="mb-0 mt-2 text-xs text-base-content/55">
                        {formatAmount(latestBackendAgent.session.maxPerTx, appConfig.coinDecimals, appConfig.coinSymbol)} /{" "}
                        {formatAmount(latestBackendAgent.session.maxTotal, appConfig.coinDecimals, appConfig.coinSymbol)}
                      </p>
                    )}
                  </article>

                  {olderBackendAgents.length > 0 && (
                    <details className="rounded-2xl border border-base-300 bg-base-100">
                      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-base-content/70">
                        Show {olderBackendAgents.length} older agent{olderBackendAgents.length > 1 ? "s" : ""}
                      </summary>
                      <div className="space-y-3 border-t border-base-300 px-4 py-4">
                        {olderBackendAgents.map(agent => (
                          <article key={agent.agentId} className="rounded-2xl border border-base-300 bg-base-200 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="m-0 text-sm font-bold">{agent.label}</p>
                                <p className="mt-1 text-xs text-base-content/50">
                                  {agent.agentType} / {agent.userId}
                                </p>
                              </div>
                              <button
                                className="btn btn-ghost btn-xs"
                                onClick={() => {
                                  setSdkAgentId(agent.agentId);
                                  setSessionKeyAddress(agent.sessionKey);
                                }}
                              >
                                Use
                              </button>
                            </div>
                            <p className="mb-0 mt-3 break-all font-mono text-xs text-base-content/60">{agent.agentId}</p>
                            <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/60">{agent.sessionKey}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
                              <span className={`badge badge-sm ${agent.hasStoredSessionKey ? "badge-success" : "badge-ghost"}`}>
                                {agent.hasStoredSessionKey ? "runtime ready" : "missing signer"}
                              </span>
                              {agent.revokedAt && <span className="badge badge-sm badge-error">revoked</span>}
                            </div>
                            {agent.session && (
                              <p className="mb-0 mt-2 text-xs text-base-content/55">
                                {formatAmount(agent.session.maxPerTx, appConfig.coinDecimals, appConfig.coinSymbol)} /{" "}
                                {formatAmount(agent.session.maxTotal, appConfig.coinDecimals, appConfig.coinSymbol)}
                              </p>
                            )}
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

          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-bold">Recent Audit</p>
              {backendReceipts.length > 1 && <span className="text-xs text-base-content/45">{backendReceipts.length} total</span>}
            </div>
            <div className="mt-4 space-y-3">
              {latestBackendReceipt ? (
                <>
                  <article className="rounded-2xl border border-base-300 bg-base-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="m-0 text-sm font-bold">{latestBackendReceipt.result}</p>
                      <span className="text-[11px] text-base-content/45">
                        {new Date(latestBackendReceipt.timestamp).toLocaleString("en-US")}
                      </span>
                    </div>
                    <p className="mb-0 mt-2 text-sm text-base-content/70">{latestBackendReceipt.reason}</p>
                    <p className="mb-0 mt-2 text-xs text-base-content/55">
                      {latestBackendReceipt.agentId} /{" "}
                      {formatAmount(latestBackendReceipt.amount, appConfig.coinDecimals, appConfig.coinSymbol)}
                    </p>
                    {latestBackendReceipt.txHash && (
                      <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/55">
                        {latestBackendReceipt.txHash}
                      </p>
                    )}
                  </article>

                  {olderBackendReceipts.length > 0 && (
                    <details className="rounded-2xl border border-base-300 bg-base-100">
                      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-base-content/70">
                        Show {olderBackendReceipts.length} older receipt{olderBackendReceipts.length > 1 ? "s" : ""}
                      </summary>
                      <div className="space-y-3 border-t border-base-300 px-4 py-4">
                        {olderBackendReceipts.map(receipt => (
                          <article key={receipt.paymentId} className="rounded-2xl border border-base-300 bg-base-200 p-4">
                            <div className="flex items-start justify-between gap-3">
                              <p className="m-0 text-sm font-bold">{receipt.result}</p>
                              <span className="text-[11px] text-base-content/45">
                                {new Date(receipt.timestamp).toLocaleString("en-US")}
                              </span>
                            </div>
                            <p className="mb-0 mt-2 text-sm text-base-content/70">{receipt.reason}</p>
                            <p className="mb-0 mt-2 text-xs text-base-content/55">
                              {receipt.agentId} / {formatAmount(receipt.amount, appConfig.coinDecimals, appConfig.coinSymbol)}
                            </p>
                            {receipt.txHash && (
                              <p className="mb-0 mt-2 break-all font-mono text-xs text-base-content/55">{receipt.txHash}</p>
                            )}
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

        <div className="space-y-6">
          <div className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20">
            <p className="text-lg font-bold">8. Mock Agent Console</p>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-base-300 bg-base-200 p-4 text-sm text-base-content/70">
                <p className="m-0 font-semibold">Minimal demo</p>
                <p className="mb-0 mt-2">
                  Give the mock agent a natural-language transfer instruction. It extracts recipient + amount, then spends through the runtime wallet using `agentId`.
                </p>
                <p className="mb-0 mt-2 text-xs leading-6 text-base-content/60">
                  Examples: `Pay 0.01 SUI to 0x... for API usage` / `transfer 0.25 to 0x...` / `send 1.5 to 0x...`
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
                placeholder="Pay 0.01 SUI to 0x... for API usage"
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
            <p className="text-lg font-bold">x402 / Receipt Verify</p>
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
            <p className="text-lg font-bold">Backend Response</p>
            <div className="mt-4 space-y-3">
              {backendServices.length > 0 && (
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Stored Services</p>
                  <div className="mt-3 space-y-2">
                    {backendServices.map(service => (
                      <div key={service.serviceId} className="text-xs text-base-content/65">
                        <p className="m-0 font-semibold">{service.description}</p>
                        <p className="m-0 break-all font-mono">{service.serviceId}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {backendApprovals.length > 0 && (
                <div className="rounded-2xl bg-base-200 p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-base-content/40">Approval Requests</p>
                  <div className="mt-3 space-y-2">
                    {backendApprovals.map(approval => (
                      <div key={approval.approvalId} className="text-xs text-base-content/65">
                        <p className="m-0 font-semibold">
                          {approval.status} / {approval.channel}
                        </p>
                        <p className="m-0">{approval.reason}</p>
                        <p className="m-0 break-all font-mono">{approval.recipient}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <pre className="overflow-auto rounded-2xl bg-base-200 p-4 text-xs leading-6 text-base-content/70">
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

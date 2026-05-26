import { AgentPaySDK, DEFAULT_COIN_TYPE, SUI_NETWORKS } from "@sui-agent-pay/sdk";
import type { AppConfig } from "@sui-agent-pay/sdk";
import os from "os";
import path from "path";

declare global {
  // eslint-disable-next-line no-var
  var __agentPaySdkSingleton: AgentPaySDK | undefined;
}

function readEnv(name: string, fallback?: string) {
  const value = process.env[name];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return fallback;
}

const TESTNET_DEPLOYMENT = {
  packageId: "0xebb525a4dbc110a2329b691adc539ff334cf4b858cccc7f98a2d970b7b56b387",
  vaultId: "0x3990846eaaf49a4d356adf5353af2717ae89df7419f0a6c0076f5d7668f2f5ed",
  registryId: "0x92524860587b34590d4f57d403be9d9182f5c894e5653b846270722fc34c5f86",
} as const;

export function loadServerConfig(): AppConfig {
  const isVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
  const configuredNetwork = readEnv("SUI_NETWORK", process.env.NEXT_PUBLIC_SUI_NETWORK || "sui-testnet") ?? "sui-testnet";
  const network = (SUI_NETWORKS[configuredNetwork as AppConfig["network"]]
    ? configuredNetwork
    : "sui-testnet") as AppConfig["network"];
  const networkDefaults = SUI_NETWORKS[network] ?? SUI_NETWORKS["sui-testnet"];
  const deploymentDefaults =
    network === "sui-testnet" ? TESTNET_DEPLOYMENT : { packageId: "0x0", vaultId: undefined, registryId: undefined };
  const defaultDbPath = isVercel ? ":memory:" : path.join(os.homedir(), ".sui-agent-pay", "agent-pay.db");

  return {
    network,
    fullnodeUrl:
      readEnv("SUI_FULLNODE_URL", readEnv("NEXT_PUBLIC_SUI_FULLNODE_URL", networkDefaults.grpcUrl)) ??
      networkDefaults.grpcUrl,
    ownerAddress: readEnv("OWNER_ADDRESS", "") ?? "",
    dbPath: isVercel ? ":memory:" : (readEnv("DB_PATH", defaultDbPath) ?? defaultDbPath),
    vaultId: readEnv("SUI_VAULT_ID", process.env.NEXT_PUBLIC_SUI_VAULT_ID || deploymentDefaults.vaultId),
    registryId: readEnv("SUI_REGISTRY_ID", process.env.NEXT_PUBLIC_SUI_REGISTRY_ID || deploymentDefaults.registryId),
    coinType: readEnv("SUI_COIN_TYPE", process.env.NEXT_PUBLIC_SUI_COIN_TYPE || DEFAULT_COIN_TYPE) ?? DEFAULT_COIN_TYPE,
    move: {
      packageId:
        readEnv("SUI_MOVE_PACKAGE_ID", process.env.NEXT_PUBLIC_SUI_MOVE_PACKAGE_ID || deploymentDefaults.packageId) ??
        deploymentDefaults.packageId,
      vaultModule:
        readEnv("SUI_VAULT_MODULE", process.env.NEXT_PUBLIC_SUI_VAULT_MODULE || "agent_vault") ?? "agent_vault",
      registryModule:
        readEnv("SUI_REGISTRY_MODULE", process.env.NEXT_PUBLIC_SUI_REGISTRY_MODULE || "agent_registry") ??
        "agent_registry",
    },
  };
}

export async function withSdk<T>(handler: (sdk: AgentPaySDK) => Promise<T> | T): Promise<T> {
  if (!globalThis.__agentPaySdkSingleton) {
    globalThis.__agentPaySdkSingleton = new AgentPaySDK(loadServerConfig());
  }

  return handler(globalThis.__agentPaySdkSingleton);
}

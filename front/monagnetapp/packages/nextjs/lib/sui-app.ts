export type FrontendSuiNetwork = "sui-localnet" | "sui-devnet" | "sui-testnet" | "sui-mainnet";

const NETWORKS: Record<
  FrontendSuiNetwork,
  {
    fullnodeUrl: string;
    sdkNetwork: "localnet" | "devnet" | "testnet" | "mainnet";
    label: string;
  }
> = {
  "sui-localnet": {
    fullnodeUrl: "http://127.0.0.1:9000",
    sdkNetwork: "localnet",
    label: "Localnet",
  },
  "sui-devnet": {
    fullnodeUrl: "https://fullnode.devnet.sui.io:443",
    sdkNetwork: "devnet",
    label: "Devnet",
  },
  "sui-testnet": {
    fullnodeUrl: "https://fullnode.testnet.sui.io:443",
    sdkNetwork: "testnet",
    label: "Testnet",
  },
  "sui-mainnet": {
    fullnodeUrl: "https://fullnode.mainnet.sui.io:443",
    sdkNetwork: "mainnet",
    label: "Mainnet",
  },
};

export const SUI_COIN_TYPE = "0x2::sui::SUI";
export const ZERO_ADDRESS = "0x0";

const TESTNET_DEPLOYMENT = {
  packageId: "0xebb525a4dbc110a2329b691adc539ff334cf4b858cccc7f98a2d970b7b56b387",
  vaultId: "0x3990846eaaf49a4d356adf5353af2717ae89df7419f0a6c0076f5d7668f2f5ed",
  registryId: "0x92524860587b34590d4f57d403be9d9182f5c894e5653b846270722fc34c5f86",
} as const;

const configuredNetwork = (process.env.NEXT_PUBLIC_SUI_NETWORK as FrontendSuiNetwork | undefined) ?? "sui-testnet";
const networkDefaults = NETWORKS[configuredNetwork] ?? NETWORKS["sui-testnet"];
const deploymentDefaults =
  configuredNetwork === "sui-testnet" ? TESTNET_DEPLOYMENT : { packageId: "0x0", vaultId: "", registryId: "" };
const configuredCoinDecimals = Number(process.env.NEXT_PUBLIC_SUI_COIN_DECIMALS || "9");

export const appConfig = {
  network: configuredNetwork,
  networkLabel: networkDefaults.label,
  sdkNetwork: networkDefaults.sdkNetwork,
  fullnodeUrl: process.env.NEXT_PUBLIC_SUI_FULLNODE_URL || networkDefaults.fullnodeUrl,
  packageId: process.env.NEXT_PUBLIC_SUI_MOVE_PACKAGE_ID || deploymentDefaults.packageId,
  vaultModule: process.env.NEXT_PUBLIC_SUI_VAULT_MODULE || "agent_vault",
  registryModule: process.env.NEXT_PUBLIC_SUI_REGISTRY_MODULE || "agent_registry",
  vaultId: process.env.NEXT_PUBLIC_SUI_VAULT_ID || deploymentDefaults.vaultId,
  registryId: process.env.NEXT_PUBLIC_SUI_REGISTRY_ID || deploymentDefaults.registryId,
  ownerAddress: process.env.NEXT_PUBLIC_OWNER_ADDRESS || "",
  coinType: process.env.NEXT_PUBLIC_SUI_COIN_TYPE || SUI_COIN_TYPE,
  coinSymbol: process.env.NEXT_PUBLIC_SUI_COIN_SYMBOL || "SUI",
  coinDecimals: Number.isFinite(configuredCoinDecimals) && configuredCoinDecimals >= 0 ? configuredCoinDecimals : 9,
} as const;

export function shortenAddress(value?: string, leading = 6, trailing = 4) {
  if (!value) {
    return "Not configured";
  }

  if (value.length <= leading + trailing) {
    return value;
  }

  return `${value.slice(0, leading)}...${value.slice(-trailing)}`;
}

export function parseAmountInput(value: string, decimals: number) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Please enter an amount");
  }

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid amount format");
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Maximum ${decimals} decimal places supported`);
  }

  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  const combined = `${normalizedWhole}${normalizedFraction}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined);
}

export function formatAmount(value: bigint | number | string, decimals: number, symbol: string) {
  const bigintValue = BigInt(value);
  const negative = bigintValue < 0n;
  const absolute = negative ? bigintValue * -1n : bigintValue;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const rendered = fraction ? `${whole.toString()}.${fraction.slice(0, 4)}` : whole.toString();
  return `${negative ? "-" : ""}${rendered} ${symbol}`;
}

export function buildAgentMetadataUri(input: { name: string; provider: string; model: string; systemPrompt: string }) {
  const payload = {
    name: input.name.trim(),
    provider: input.provider.trim(),
    model: input.model.trim(),
    systemPrompt: input.systemPrompt.trim(),
    chain: "sui",
    packageId: appConfig.packageId,
  };

  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

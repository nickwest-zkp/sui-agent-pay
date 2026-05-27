import type { DeepBookSwapMetadata } from "@sui-agent-pay/sdk";

const TESTNET_DEEPBOOK_PACKAGE_ID = "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982";
const TESTNET_DEEP_COIN_TYPE = "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";
const TESTNET_DBUSDC_COIN_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";
const SUI_COIN_TYPE = "0x2::sui::SUI";

export const TESTNET_DEEPBOOK_POOLS = {
  SUI_DBUSDC: {
    poolId: "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5",
    baseCoinType: SUI_COIN_TYPE,
    quoteCoinType: TESTNET_DBUSDC_COIN_TYPE,
    lotSize: 1_000_000n,
  },
} as const;

function normalizeSymbol(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "USDC") return "DBUSDC";
  return normalized;
}

export function buildDeepBookSwapMetadata(args: {
  network: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: string;
  walletAddress?: string;
}): DeepBookSwapMetadata {
  if (args.network !== "sui-testnet") {
    throw new Error(`DeepBook demo swap currently supports only sui-testnet, received ${args.network}`);
  }

  const fromSymbol = normalizeSymbol(args.inputSymbol);
  const toSymbol = normalizeSymbol(args.outputSymbol);

  if (fromSymbol === "SUI" && toSymbol === "DBUSDC") {
    if (BigInt(args.inputAmount) < TESTNET_DEEPBOOK_POOLS.SUI_DBUSDC.lotSize) {
      throw new Error("DeepBook SUI/USDC demo requires at least 0.001 SUI because of the testnet lot size");
    }

    return {
      packageId: TESTNET_DEEPBOOK_PACKAGE_ID,
      walletAddress: args.walletAddress,
      inputCoinType: SUI_COIN_TYPE,
      outputCoinType: TESTNET_DBUSDC_COIN_TYPE,
      inputAmount: args.inputAmount,
      deepCoinType: TESTNET_DEEP_COIN_TYPE,
      route: [
        {
          poolId: TESTNET_DEEPBOOK_POOLS.SUI_DBUSDC.poolId,
          baseCoinType: TESTNET_DEEPBOOK_POOLS.SUI_DBUSDC.baseCoinType,
          quoteCoinType: TESTNET_DEEPBOOK_POOLS.SUI_DBUSDC.quoteCoinType,
          direction: "base_to_quote",
          minOutputAmount: "1",
        },
      ],
    };
  }

  throw new Error(`DeepBook demo swap does not support ${fromSymbol} -> ${toSymbol} yet`);
}

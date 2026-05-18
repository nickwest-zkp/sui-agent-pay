"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { appConfig } from "~~/lib/sui-app";

export function createSuiDAppKit() {
  return createDAppKit({
    networks: [appConfig.sdkNetwork] as const,
    createClient: () => new SuiJsonRpcClient({ network: appConfig.sdkNetwork, url: appConfig.fullnodeUrl }),
    autoConnect: true,
  });
}

export type SuiDAppKit = ReturnType<typeof createSuiDAppKit>;

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: SuiDAppKit;
  }
}

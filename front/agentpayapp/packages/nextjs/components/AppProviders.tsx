"use client";

import { useMemo } from "react";
import { ThemeProvider } from "~~/components/ThemeProvider";
import { createSuiDAppKit } from "~~/lib/sui-dapp-kit";
import { DAppKitProvider } from "~~/lib/sui-wallet-core";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const dAppKit = useMemo(() => (typeof window === "undefined" ? null : createSuiDAppKit()), []);

  return (
    <ThemeProvider>
      {dAppKit ? <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider> : children}
    </ThemeProvider>
  );
}

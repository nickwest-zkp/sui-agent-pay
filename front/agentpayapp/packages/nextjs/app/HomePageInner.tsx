"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { appConfig, shortenAddress } from "~~/lib/sui-app";
import { ConnectButton } from "~~/lib/sui-connect-button";
import { useCurrentAccount, useCurrentNetwork } from "~~/lib/sui-wallet-core";

const landingCards = [
  {
    title: "Sui Wallet Standard",
    text: "Wallet connection, signing, and transaction submission all go through the Sui wallet standard.",
  },
  {
    title: "Shared Object Flow",
    text: "The console is aligned with the Move flow around shared objects, session keys, and vault-based payments.",
  },
  {
    title: "Demo First",
    text: "The current goal is a usable hackathon demo: configure the wallet, run the payment path, then wire the agent runtime on top.",
  },
];

function HomePageContent() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();

  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(circle_at_top,rgba(20,184,166,0.22),transparent_58%),linear-gradient(180deg,rgba(15,23,42,0.06),transparent)]" />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-6 py-12 lg:px-10 lg:py-16">
        <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[2rem] border border-base-300/70 bg-base-100/90 p-8 shadow-xl shadow-base-300/25 backdrop-blur">
            <span className="badge badge-outline border-primary/30 bg-primary/5 px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">
              Sui Agent Wallet
            </span>
            <h1 className="mt-6 text-4xl font-black tracking-tight lg:text-6xl">A Sui-only console for agent payments</h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-base-content/70 lg:text-lg">
              This version focuses only on Sui. You can connect a wallet, create the vault object, authorize a session
              key, sync a local runtime agent, and run the payment demo end to end.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/dashboard" className="btn btn-primary rounded-full px-6">
                Open dashboard
              </Link>
              <ConnectButton />
            </div>
          </div>

          <div className="grid gap-4">
            <div className="rounded-[2rem] border border-base-300/70 bg-neutral p-6 text-neutral-content shadow-xl shadow-neutral/15">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-neutral-content/60">Current Session</p>
              <div className="mt-5 space-y-3">
                <div>
                  <p className="text-sm text-neutral-content/60">Wallet</p>
                  <p className="mt-1 font-mono text-sm">{account ? shortenAddress(account.address) : "Not connected"}</p>
                </div>
                <div>
                  <p className="text-sm text-neutral-content/60">Network</p>
                  <p className="mt-1 text-sm">{network ?? appConfig.network}</p>
                </div>
                <div>
                  <p className="text-sm text-neutral-content/60">Move Package</p>
                  <p className="mt-1 font-mono text-sm">{shortenAddress(appConfig.packageId)}</p>
                </div>
              </div>
            </div>

            <div className="rounded-[2rem] border border-base-300/70 bg-base-100 p-6 shadow-xl shadow-base-300/25">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-base-content/45">Configured Objects</p>
              <div className="mt-5 space-y-4 text-sm">
                <div>
                  <p className="text-base-content/50">Vault ID</p>
                  <p className="mt-1 font-mono">{appConfig.vaultId ? shortenAddress(appConfig.vaultId) : "Not configured"}</p>
                </div>
                <div>
                  <p className="text-base-content/50">Registry ID</p>
                  <p className="mt-1 font-mono">{appConfig.registryId ? shortenAddress(appConfig.registryId) : "Not configured"}</p>
                </div>
                <p className="rounded-2xl bg-base-200 px-4 py-3 text-xs leading-6 text-base-content/65">
                  After initial deployment, write the shared object IDs back into `.env.local` so the dashboard can use
                  the existing vault and registry directly.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {landingCards.map(card => (
            <article
              key={card.title}
              className="rounded-[1.75rem] border border-base-300/70 bg-base-100 p-6 shadow-lg shadow-base-300/20"
            >
              <p className="text-lg font-bold">{card.title}</p>
              <p className="mt-3 text-sm leading-7 text-base-content/65">{card.text}</p>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

export default dynamic(async () => HomePageContent, { ssr: false });

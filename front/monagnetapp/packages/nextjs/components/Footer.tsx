import { appConfig } from "~~/lib/sui-app";

export function Footer() {
  return (
    <footer className="border-t border-base-300/70 bg-base-100/70">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-6 text-sm text-base-content/55 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <p className="m-0">Sui Agent Pay is a Sui-only demo console for vault, session key, and agent wallet flows.</p>
        <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
          <span>{appConfig.network}</span>
          <span>{appConfig.coinSymbol}</span>
          <span>{appConfig.vaultModule}</span>
          <span>{appConfig.registryModule}</span>
        </div>
      </div>
    </footer>
  );
}

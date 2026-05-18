"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { ConnectButton } from "~~/lib/sui-connect-button";

const navItems = [
  { href: "/", label: "Overview" },
  { href: "/dashboard", label: "Dashboard" },
];

function HeaderContent() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-base-300/70 bg-base-100/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#0f172a,#14b8a6)] text-sm font-black text-white shadow-lg shadow-primary/20">
            S
          </div>
          <div>
            <Link href="/" className="text-sm font-black uppercase tracking-[0.22em] text-base-content">
              Sui Agent Pay
            </Link>
            <p className="text-xs text-base-content/50">Move-native wallet console</p>
          </div>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          {navItems.map(item => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  active
                    ? "bg-primary text-primary-content shadow-md shadow-primary/20"
                    : "text-base-content/65 hover:bg-base-200"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden md:block">
            <SwitchTheme />
          </div>
          <div className="hidden sm:block">
            <ConnectButton />
          </div>
          <details className="dropdown dropdown-end md:hidden">
            <summary className="btn btn-ghost btn-circle">
              <Bars3Icon className="h-5 w-5" />
            </summary>
            <ul className="menu dropdown-content mt-3 w-56 rounded-2xl border border-base-300 bg-base-100 p-2 shadow-xl">
              {navItems.map(item => (
                <li key={item.href}>
                  <Link href={item.href}>{item.label}</Link>
                </li>
              ))}
              <li className="mt-2 px-2">
                <ConnectButton />
              </li>
              <li className="mt-2 px-2">
                <SwitchTheme />
              </li>
            </ul>
          </details>
        </div>
      </div>
    </header>
  );
}

export const Header = dynamic(async () => HeaderContent, { ssr: false });

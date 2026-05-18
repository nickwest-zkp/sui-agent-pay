"use client";

import dynamic from "next/dynamic";

const HeaderClient = dynamic(() => import("~~/components/HeaderClient").then(module => module.Header), { ssr: false });

export function Header() {
  return <HeaderClient />;
}

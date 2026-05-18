"use client";

import dynamic from "next/dynamic";

const HeaderInner = dynamic(() => import("~~/components/HeaderInner").then(module => module.Header), { ssr: false });

export function Header() {
  return <HeaderInner />;
}

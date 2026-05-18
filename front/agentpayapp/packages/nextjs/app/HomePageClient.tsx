"use client";

import dynamic from "next/dynamic";

const HomePageInner = dynamic(() => import("~~/app/HomePageInner"), { ssr: false });

export default function HomePageClient() {
  return <HomePageInner />;
}

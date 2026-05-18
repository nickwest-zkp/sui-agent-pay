"use client";

import dynamic from "next/dynamic";

const HomePageClient = dynamic(() => import("~~/app/HomePageClient"), { ssr: false });

export default function HomePage() {
  return <HomePageClient />;
}

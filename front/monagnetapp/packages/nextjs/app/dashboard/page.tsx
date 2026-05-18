"use client";

import dynamic from "next/dynamic";

const DashboardPageClient = dynamic(() => import("~~/app/dashboard/DashboardPageClient"), { ssr: false });

export default function DashboardPage() {
  return <DashboardPageClient />;
}

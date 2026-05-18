"use client";

import dynamic from "next/dynamic";

const DashboardPageInner = dynamic(() => import("~~/app/dashboard/DashboardPageInner"), { ssr: false });

export default function DashboardPageClient() {
  return <DashboardPageInner />;
}

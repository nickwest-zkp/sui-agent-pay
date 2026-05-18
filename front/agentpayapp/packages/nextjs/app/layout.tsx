import type { Metadata } from "next";
import { AppProviders } from "~~/components/AppProviders";
import { Footer } from "~~/components/Footer";
import { Header } from "~~/components/Header";
import "~~/styles/globals.css";

export const metadata: Metadata = {
  title: "Sui Agent Pay",
  description: "Agent wallet console built for Sui.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-base-200 text-base-content">
        <AppProviders>
          <div className="relative flex min-h-screen flex-col">
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
        </AppProviders>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { DemoSessionProvider } from "@/app/providers";

export const metadata: Metadata = {
  title: "ClinicStock",
  // Mode-neutral: this build may run against a real clinic's database, so the
  // description must not claim the data is synthetic. The DEMO banner in
  // AppShell is where that claim belongs, and it renders only in demo mode.
  description:
    "Inventory management for small clinics: products, batches, expiry monitoring and auditable stock movements.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <DemoSessionProvider>{children}</DemoSessionProvider>
      </body>
    </html>
  );
}

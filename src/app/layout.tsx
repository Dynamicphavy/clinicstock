import type { Metadata } from "next";
import "./globals.css";
import { DemoSessionProvider } from "@/app/providers";

export const metadata: Metadata = {
  title: "ClinicStock",
  description: "Inventory management for small clinics. Demo build, synthetic data.",
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

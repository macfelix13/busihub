import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Busihub — Point of Sale for growing businesses",
    template: "%s · Busihub",
  },
  description:
    "Busihub is a multi-tenant Point-of-Sale and business management platform built for small retail businesses in Ghana and beyond.",
  manifest: "/manifest.webmanifest",
  applicationName: "Busihub",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Busihub",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#06271c" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
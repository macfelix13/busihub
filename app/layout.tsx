import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://busihub.vercel.app"),
  title: {
    default: "Busihub — POS & Business Management Software for Modern Businesses",
    template: "%s · Busihub",
  },
  description:
    "Busihub helps businesses manage sales, inventory, payments, customers and reports from one simple POS platform.",
  manifest: "/manifest.webmanifest",
  applicationName: "Busihub",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Busihub",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Busihub",
    title: "Busihub — POS & Business Management Software for Modern Businesses",
    description:
      "Busihub helps businesses manage sales, inventory, payments, customers and reports from one simple POS platform.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Busihub — POS & Business Management Software for Modern Businesses",
    description:
      "Busihub helps businesses manage sales, inventory, payments, customers and reports from one simple POS platform.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1a13" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-canvas font-sans antialiased dark:bg-canvas-dark">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
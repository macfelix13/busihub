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

/**
 * Applies the dark/light class to <html> BEFORE the rest of the page
 * paints — a plain inline script, not a React effect, because an effect
 * only runs after the first paint and would show the wrong theme for one
 * visible frame on every load. This is the same "first child of body"
 * technique most no-flash theme scripts use (next-themes included): a
 * script here runs synchronously as the browser reaches it, ahead of
 * every element after it, so `dark` is already set (or not) before
 * anything below has a chance to render in the wrong theme.
 *
 * Per-device preference, deliberately not a per-user account setting or a
 * business-wide setting: `localStorage` is what a browser on a shared
 * till terminal actually is — the choice sticks to that terminal,
 * regardless of which staff member is signed in, which is normally
 * exactly what a shop wants (nobody has to re-set it every shift change).
 * `components/ui/theme-toggle.tsx` is what writes to the same key.
 *
 * Falls back to the OS/browser's prefers-color-scheme ONLY when nothing
 * has been explicitly chosen on this device yet; the first real click of
 * the toggle overrides that permanently (for this device) either way.
 */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('busihub-theme');
    var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-canvas font-sans antialiased dark:bg-canvas-dark">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
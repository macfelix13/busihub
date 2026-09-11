import Link from "next/link";

/**
 * Every link below goes somewhere real: an in-page anchor on this same
 * landing page, or an actual route (/login, /register, /privacy,
 * /terms). No "About"/"Contact"/"Blog" links, because those pages don't
 * exist yet — an unclickable-in-spirit link would fail the spec's own
 * "no dead links, no buttons that do nothing" requirement.
 */
const PRODUCT_LINKS = [
  { href: "#features", label: "POS" },
  { href: "#features", label: "Inventory" },
  { href: "#payments", label: "Payments" },
  { href: "#features", label: "Reports" },
  { href: "#features", label: "Customers" },
  { href: "#barcode", label: "Barcode scanning" },
];

const SOLUTIONS_LINKS = [
  { href: "#solutions", label: "Retail" },
  { href: "#solutions", label: "Salons & barbershops" },
  { href: "#solutions", label: "Restaurants" },
  { href: "#solutions", label: "Service businesses" },
];

const COMPANY_LINKS = [
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
];

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-neutral-900 dark:text-ink">{title}</p>
      <ul className="mt-3 flex flex-col gap-2.5">
        {links.map((link) => (
          <li key={`${title}-${link.label}`}>
            <a href={link.href} className="text-sm text-neutral-500 hover:text-neutral-800 dark:text-ink-muted dark:hover:text-ink">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-neutral-200 bg-canvas dark:border-surface-line dark:bg-surface/40">
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="sm:col-span-2 lg:col-span-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-lime-400 text-xs font-bold text-brand-950">
                B
              </span>
              <span className="text-base font-semibold text-neutral-900 dark:text-ink">Busihub</span>
            </div>
            <p className="mt-3 max-w-xs text-sm text-neutral-500 dark:text-ink-muted">
              Point of sale and business management for shops and service businesses in Ghana.
            </p>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Solutions" links={SOLUTIONS_LINKS} />
          <FooterColumn title="Company" links={COMPANY_LINKS} />
          <FooterColumn title="Legal" links={LEGAL_LINKS} />
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-neutral-200 pt-6 dark:border-surface-line sm:flex-row">
          <p className="text-xs text-neutral-500 dark:text-ink-muted">© 2026 Busihub. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:text-ink-muted dark:hover:text-ink">
              Sign in
            </Link>
            <Link href="/register" className="text-xs font-medium text-brand-950 hover:underline dark:text-brand-400">
              Get started
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
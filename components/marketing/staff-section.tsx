import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SectionHeading } from "./section-heading";

// Real built-in roles — lib/rbac/permissions.ts BUILT_IN_ROLE_NAMES.
const ROLES = ["Owner", "Manager", "Cashier", "Inventory Manager", "Accountant", "Auditor"];

const CAPABILITIES = [
  "Cashier accounts, separate from the owner's login",
  "Role-based permissions for every part of the app",
  "A discount cap so cashiers can't discount without limit",
  "Sales tracked by the cashier who made them",
  "An audit trail of sensitive changes",
];

export function StaffSection() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <SectionHeading
          align="left"
          eyebrow="Staff & cashiers"
          title="Give your team the tools they need."
          description="Business owners can manage staff and cashier access, and control exactly what each person can do."
        />
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-surface-line dark:bg-surface-card">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-ink-muted">
            Built-in roles
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ROLES.map((role) => (
              <Badge key={role} variant="brand">
                {role}
              </Badge>
            ))}
          </div>
          <ul className="mt-5 flex flex-col gap-2.5 border-t border-neutral-200 pt-5 dark:border-surface-line">
            {CAPABILITIES.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-ink-muted">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
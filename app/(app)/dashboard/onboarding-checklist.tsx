import Link from "next/link";
import { CheckCircle2, Circle, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dismissOnboardingChecklist } from "./onboarding-actions";

export interface OnboardingStatus {
  has_product: boolean;
  has_stock: boolean;
  has_sale: boolean;
  payment_connected: boolean;
  has_extra_staff: boolean;
  dismissed: boolean;
}

interface Step {
  key: keyof Omit<OnboardingStatus, "dismissed">;
  label: string;
  href: string;
}

// Deliberately derived entirely from onboarding_status() (0053), which
// reads real tables under the caller's own RLS — nothing here is a
// separately-tracked "did they see this" flag that could drift from what
// the business has actually done. Ordered the way a brand-new shop would
// naturally do them, not alphabetically.
const STEPS: Step[] = [
  { key: "has_product", label: "Add your first product or service", href: "/products/new" },
  { key: "has_stock", label: "Get some stock in", href: "/inventory/receive" },
  { key: "has_sale", label: "Make your first sale", href: "/till" },
  { key: "payment_connected", label: "Connect Paystack for card & mobile money", href: "/settings/payments" },
  { key: "has_extra_staff", label: "Invite a staff member", href: "/settings/staff/new" },
];

/**
 * First-run setup checklist for the dashboard. Only ever rendered by the
 * caller (app/(app)/dashboard/page.tsx) when the signed-in user has
 * business.manage — a cashier doesn't need to be told to connect
 * Paystack — and only while there's something left to do: the page
 * decides not to render this at all once every step is complete or the
 * business has dismissed it, so there's no "all done!" state to design
 * here.
 */
export function OnboardingChecklist({ status }: { status: OnboardingStatus }) {
  const completedCount = STEPS.filter((step) => status[step.key]).length;

  return (
    <Card className="relative overflow-hidden border-lime-500/30 dark:border-lime-400/20">
      <form action={dismissOnboardingChecklist} className="absolute right-3 top-3">
        <SubmitButton
          variant="ghost"
          pendingText="…"
          className="h-8 w-8 min-h-0 shrink-0 overflow-hidden rounded-full p-0 text-xs"
          aria-label="Hide this checklist"
        >
          <X className="h-4 w-4" />
        </SubmitButton>
      </form>

      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1 pr-8">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-ink">Get Busihub set up</h2>
          <p className="text-sm text-neutral-500 dark:text-ink-muted">
            {completedCount} of {STEPS.length} done — a few quick steps to get real use out of your trial.
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {STEPS.map((step) => {
            const done = status[step.key];
            return (
              <li key={step.key}>
                <Link
                  href={step.href}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm transition-colors",
                    done
                      ? "text-neutral-400 line-through dark:text-ink-muted"
                      : "text-neutral-800 hover:border-neutral-200 hover:bg-neutral-50 dark:text-ink dark:hover:border-surface-line dark:hover:bg-surface/60"
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-lime-600 dark:text-lime-400" />
                  ) : (
                    <Circle className="h-5 w-5 shrink-0 text-neutral-300 dark:text-ink-muted" />
                  )}
                  <span className={done ? "" : "font-medium"}>{step.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}
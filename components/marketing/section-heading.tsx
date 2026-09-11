import { cn } from "@/lib/utils";

/**
 * The one heading block every marketing section on this page uses —
 * optional eyebrow label, an H2 (sections are h2; the hero owns the
 * page's single h1), and optional supporting copy. Centralised so every
 * section's heading has the same size/spacing/measure rather than each
 * one drifting slightly, and so the eyebrow's brand-pill styling is
 * defined once.
 */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        align === "center" ? "mx-auto max-w-2xl items-center text-center" : "max-w-2xl items-start text-left",
        className
      )}
    >
      {eyebrow ? (
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="text-balance text-2xl font-semibold tracking-tight text-neutral-900 dark:text-ink sm:text-3xl">
        {title}
      </h2>
      {description ? (
        <p className="text-pretty text-base text-neutral-600 dark:text-ink-muted">{description}</p>
      ) : null}
    </div>
  );
}
import { cn } from "@/lib/utils";

/**
 * The one loading spinner this app uses everywhere a "this is working"
 * indicator is needed — buttons, page-level loading states, modals. Pure
 * CSS (Tailwind's built-in `animate-spin`), no animation library, so it's
 * as cheap as the plain text it replaces ("Loading…", "Please wait…").
 *
 * `currentColor` on both the track and the arc (opacity is what makes the
 * arc read as an arc, not the color) means this always matches whatever
 * text color it's dropped next to — a spinner inside a white-text primary
 * button, or dark neutral text elsewhere — with no color prop to thread
 * through every call site.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-4 w-4 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
    </svg>
  );
}
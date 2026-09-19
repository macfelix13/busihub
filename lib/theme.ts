/**
 * Business-wide theme default (Settings → Business → Appearance) vs. the
 * per-device toggle (components/ui/theme-toggle.tsx) vs. Busihub's global
 * default (app/layout.tsx's THEME_INIT_SCRIPT: dark, unless a device has
 * already stored its own preference).
 *
 * "system" is business_settings.appearance_settings' DB default (0002) —
 * every business that has never touched this dropdown is on "system"
 * today, whether they realize it or not (the dropdown saved a value but
 * nothing ever read it back, until this file). Treating "system" as "no
 * override" here — rather than "follow the visiting browser's OS
 * setting" — keeps today's behavior (Busihub's standard dark look on a
 * fresh browser) unchanged for every business that hasn't made a
 * deliberate choice. Only an owner explicitly picking "Light" or "Dark"
 * in Settings does anything new: that becomes what a new staff member's
 * browser opens to, on top of the same global default, until that
 * specific device's own toggle overrides it going forward.
 *
 * If a business would rather "System" actually track each visiting
 * device's OS preference, that's a deliberate follow-up, not this one —
 * ask before changing this default treatment, since it would change the
 * first-load appearance for every business that has never touched the
 * setting.
 */
export function resolveBusinessThemeOverride(theme: string | null | undefined): "light" | "dark" | null {
  return theme === "light" || theme === "dark" ? theme : null;
}

/**
 * Inline, render-blocking script — same no-flash technique as
 * app/layout.tsx's THEME_INIT_SCRIPT, one layer further in (rendered
 * from app/(app)/layout.tsx, right before AppShell). Runs immediately
 * after that outer script, still before anything below it paints.
 *
 * Only takes effect when this device has never set its own preference
 * (checked here again in the browser, not just trusted from the
 * server — business_settings can't see localStorage): a returning staff
 * member's own choice, once made, always wins over whatever the business
 * is configured for today or changes to later. That choice can be
 * "accepted the business default, then explicitly switched away from
 * it" just as much as an original pick — the toggle doesn't distinguish
 * the two, by design (components/ui/theme-toggle.tsx).
 */
export function businessThemeOverrideScript(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  return `
(function () {
  try {
    if (localStorage.getItem('busihub-theme')) return;
    document.documentElement.classList.toggle('dark', ${dark});
  } catch (e) {}
})();
`;
}
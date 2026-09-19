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

/**
 * Business-wide accent color (Settings → Business → Appearance's
 * "Primary color") — makes the business's chosen hex actually drive the
 * app's buttons, links, focus rings, checkboxes and small accent badges,
 * everywhere those currently pull from Tailwind's fixed `brand`/`lime`
 * color families (tailwind.config.ts). Rendered as a plain `<style>`
 * block by app/(app)/layout.tsx, right alongside the theme override
 * script above — no client-side script needed here, since a color has no
 * per-device "already chosen" state to defer to the way theme does.
 *
 * DELIBERATELY DOES NOT TOUCH:
 * - brand-950 (and canvas.dark/surface-*, which are separately hardcoded
 *   to the exact same hex) — this is the entire dark-mode page
 *   background and sidebar fill, not an accent. Overriding it per
 *   business risked an unlucky color choice making large areas of the
 *   app hard to read. Confirmed with the user before building this.
 * - Anything outside app/(app)/layout.tsx (the marketing site, /login,
 *   /register) — those pages have no signed-in business to look up, so
 *   they always show Busihub's own brand colors, same as the theme
 *   override above only ever applying to signed-in app pages.
 */

const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/;

/**
 * 0002's DB default for appearance_settings.primary_color — every
 * business that has never touched this field is sitting on this exact
 * value today, the same "untouched setting" problem resolveBusinessThemeOverride()
 * solves for "system". There's no separate "not set" sentinel in the
 * schema for a color the way there is for theme, so this literal value
 * does double duty as one: a business would have to deliberately
 * re-enter this exact hex, byte for byte, to be mistaken for "hasn't
 * customized it yet" — an acceptable, explained trade-off rather than a
 * schema change.
 */
export const DEFAULT_PRIMARY_COLOR = "#22a56d";

/**
 * Null unless the business has genuinely chosen a color that isn't the
 * untouched factory default — see DEFAULT_PRIMARY_COLOR's own comment.
 * Also null for anything that isn't a plain `#rrggbb` string, since a
 * corrupted or hand-edited settings row should fall back to Busihub's
 * normal look rather than break the page.
 */
export function resolvePrimaryColorOverride(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const normalized = hex.trim().toLowerCase();
  if (!HEX_COLOR_RE.test(normalized)) return null;
  if (normalized === DEFAULT_PRIMARY_COLOR.toLowerCase()) return null;
  return normalized;
}

interface Hsl {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

function hexToRgb(hex: string): [number, number, number] {
  const match = HEX_COLOR_RE.exec(hex);
  const value = match ? match[1]! : "22a56d";
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
  }
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sn = s / 100;
  const ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return [v, v, v];
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hueToRgb = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hn = h / 360;
  return [
    Math.round(hueToRgb(hn + 1 / 3) * 255),
    Math.round(hueToRgb(hn) * 255),
    Math.round(hueToRgb(hn - 1 / 3) * 255),
  ];
}

export const ACCENT_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export type AccentShade = (typeof ACCENT_SHADES)[number];

/**
 * Target lightness for each shade, light to dark — the same "50 is a
 * faint tint, 900 is nearly black" shape Tailwind's own stock scales
 * use. Hue and saturation come from the business's chosen color and stay
 * fixed across every stop; only lightness moves. Deliberately NOT
 * anchored to the input color's own lightness at any one stop (e.g.
 * forcing 500 to equal the input exactly) — a fixed ladder behaves
 * sensibly for both a very light and a very dark input, where anchoring
 * a middle stop to the input itself would leave the stops near it barely
 * distinguishable.
 */
const LIGHTNESS_LADDER: Record<AccentShade, number> = {
  50: 97,
  100: 93,
  200: 86,
  300: 76,
  400: 64,
  500: 52,
  600: 42,
  700: 34,
  800: 26,
  900: 20,
};

/** "R G B" — the space-separated triple Tailwind's `rgb(var(--x) / <alpha-value>)` convention expects, never a leading/trailing space or a hex string. */
function rgbTriple(r: number, g: number, b: number): string {
  return `${r} ${g} ${b}`;
}

/**
 * Generates the accent ramp's "R G B" triples for every shade from one
 * business-chosen hex — null input (nothing to override) is the caller's
 * job to check first via resolvePrimaryColorOverride().
 */
export function generateAccentRamp(hex: string): Record<AccentShade, string> {
  const [r, g, b] = hexToRgb(hex);
  const { h, s } = rgbToHsl(r, g, b);
  const ramp = {} as Record<AccentShade, string>;
  for (const shade of ACCENT_SHADES) {
    const [rr, gg, bb] = hslToRgb(h, s, LIGHTNESS_LADDER[shade]);
    ramp[shade] = rgbTriple(rr, gg, bb);
  }
  return ramp;
}

/**
 * Relative luminance (WCAG's formula) of the ramp's "400" stop — the
 * shade buttons and logo badges actually paint their background with —
 * decides whether text drawn on top of it should be light or dark.
 * Needed because button.tsx's primary variant (and a couple of matching
 * chips in the sidebar/header) used to hardcode dark text on the
 * assumption that shade was always a light color (lime-400 always was);
 * a business-chosen color's "400" stop isn't guaranteed to be light.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/** Matches app/globals.css's default --accent-fg (brand-950, "8 44 36") for a light shade, white for a dark one. */
export function accentForegroundTriple(shade400Triple: string): string {
  const [r, g, b] = shade400Triple.split(" ").map(Number);
  const luminance = relativeLuminance(r ?? 0, g ?? 0, b ?? 0);
  return luminance > 0.4 ? "8 44 36" : "255 255 255";
}

/**
 * The `<style>` block's full CSS text — every brand/lime shade except
 * brand-950 (see this section's own header comment), plus accent-fg,
 * reassigned from the generated ramp. The brand and lime families end up
 * sharing one ramp so a business's single chosen color reads as one
 * consistent accent, not two separate hues the way the fixed defaults are
 * (green links/badges, yellow buttons/focus rings) — see app/globals.css's
 * defaults for the two-hue starting point this replaces once customized.
 */
export function accentOverrideStyle(hex: string): string {
  const ramp = generateAccentRamp(hex);
  const fg = accentForegroundTriple(ramp[400]);
  const lines = [
    // brand-950 is deliberately absent — it's never in ACCENT_SHADES to
    // begin with (this section's own header comment explains why).
    ...(["brand", "lime"] as const).flatMap((family) => ACCENT_SHADES.map((shade) => `--${family}-${shade}: ${ramp[shade]};`)),
    `--accent-fg: ${fg};`,
  ];
  return `:root {\n  ${lines.join("\n  ")}\n}`;
}
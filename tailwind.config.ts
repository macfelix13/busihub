import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Every shade except 950 is now a CSS variable, not a literal hex
        // — Settings → Business settings → Appearance's "Primary color"
        // (app/(app)/layout.tsx + lib/theme.ts's accentOverrideStyle())
        // overrides these on :root for a signed-in business that has
        // chosen a color, which is why the values below read as plain
        // numbers rather than hex strings: `rgb(var(--brand-500) /
        // <alpha-value>)` is Tailwind's documented pattern for a
        // themeable color that still supports opacity modifiers
        // (`bg-brand-500/40` etc.) — see app/globals.css for what these
        // variables default to (the exact hex values this file used to
        // hardcode, so nothing looks different until a business actually
        // customizes their color) and lib/theme.ts's own header comment
        // for exactly which shades this system touches and why 950 is
        // excluded.
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          300: "rgb(var(--brand-300) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
          800: "rgb(var(--brand-800) / <alpha-value>)",
          900: "rgb(var(--brand-900) / <alpha-value>)",
          // NOT a CSS variable, unlike every shade above — this is the
          // entire dark-mode page background and sidebar fill (identical
          // to canvas.dark/surface.* below, on purpose, see canvas's own
          // comment), not an accent. Confirmed with the user before
          // building the Primary color feature: overriding this per
          // business risked an unlucky color choice making large areas
          // of the app hard to read, so it stays Busihub's fixed dark
          // green no matter what a business picks.
          950: "#082c24",
        },
        // A second, brighter accent used ONLY on top of the dark surfaces
        // above — an active nav icon, a small highlight, a chart's second
        // series, a primary CTA — never as a large fill. Retuned 2026-09-11:
        // this used to be a muted olive-green (400 was #b0d840) rather than
        // the vivid "Busihub Lime Yellow" the brand actually calls for; 400
        // is now the real brand hex, with the rest of the ramp rebuilt
        // around it at the same hue/saturation.
        //
        // Every shade here is a CSS variable too, for the same
        // Primary-color reason as `brand` above — with no shade excluded
        // this time, since lime is never used as a large background
        // fill anywhere (see lib/theme.ts's header comment).
        lime: {
          50: "rgb(var(--lime-50) / <alpha-value>)",
          100: "rgb(var(--lime-100) / <alpha-value>)",
          200: "rgb(var(--lime-200) / <alpha-value>)",
          300: "rgb(var(--lime-300) / <alpha-value>)",
          400: "rgb(var(--lime-400) / <alpha-value>)",
          500: "rgb(var(--lime-500) / <alpha-value>)",
          600: "rgb(var(--lime-600) / <alpha-value>)",
          700: "rgb(var(--lime-700) / <alpha-value>)",
          800: "rgb(var(--lime-800) / <alpha-value>)",
          900: "rgb(var(--lime-900) / <alpha-value>)",
        },
        // Text color for anything painted on top of the accent ramp's
        // "400" stop (buttons, the sidebar/header logo & avatar chips) —
        // dark green by default (matching today's hardcoded text-brand-950
        // on those exact spots), recomputed for contrast whenever a
        // business's chosen color makes that stop dark rather than light.
        // See lib/theme.ts's accentForegroundTriple().
        "accent-fg": "rgb(var(--accent-fg) / <alpha-value>)",
        // The page background behind cards — distinct from card white and
        // from brand-950 (sidebar/hero cards), so the two don't have to
        // share one token doing two jobs. canvas.dark retuned to the exact
        // brand hex alongside brand-950 above (same value, by design — the
        // brand spec uses one "primary background" for both the page and
        // the nav). canvas.DEFAULT snapped to the brand spec's exact warm
        // white — #f7f6f2 before this was already almost this color.
        canvas: {
          DEFAULT: "#f5f7f2",
          dark: "#082c24",
        },
        // New 2026-09-11: the dark theme's elevation system. Until now
        // every dark-mode surface ABOVE canvas.dark — Card, Modal,
        // Field/Select/Textarea — used a plain desaturated gray
        // (neutral-800/900), which is why dark mode read as "green
        // sidebar, gray everything else" rather than one consistent
        // forest. These replace that gray staircase with tinted-green
        // surfaces, each a step lighter than canvas.dark, applied via
        // dark: at each component (light mode is untouched):
        //   surface       (#0D3B32) one step up — sticky headers, an
        //                 active nav item, a secondary panel.
        //   surface-card  (#123F35) two steps up — Card, Modal, dropdowns:
        //                 anything that reads as "a card floating on the
        //                 page."
        //   surface-line  (#28564B) the border/divider drawn on any
        //                 surface above, replacing neutral-700/800.
        //   surface-deep  (#041A15) BELOW canvas.dark, not above it — an
        //                 inset well or deep overlay, anywhere that
        //                 should look recessed rather than raised.
        surface: {
          DEFAULT: "#0d3b32",
          card: "#123f35",
          line: "#28564b",
          deep: "#041a15",
        },
        // New 2026-09-11: text tokens for the same elevation system.
        // Light mode is untouched and keeps its existing neutral-* text
        // scale — these are only ever used behind dark:.
        //   ink        (#F5F7F2) primary text on any surface above.
        //   ink-muted  (#B7C8C1) secondary/muted text on the same
        //              surfaces, replacing neutral-400.
        ink: {
          DEFAULT: "#f5f7f2",
          muted: "#b7c8c1",
        },
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      // Shared entrance animations for toasts, modals, and anything else
      // that appears rather than always being on screen — kept inside the
      // 150-300ms range so they read as quick and professional rather
      // than as decoration. Tailwind's own `motion-reduce:` variant (used
      // at each call site) turns these off for prefers-reduced-motion,
      // and app/globals.css also shortens every animation/transition to
      // near-zero globally as a second layer of that same preference.
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { transform: "translateY(16px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        "slide-down": {
          from: { transform: "translateY(-8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        // New 2026-09-11 for the POS/till motion system (see
        // app/(app)/till/till.tsx and components/ui/barcode-scanner-modal.tsx):
        // a quick scale-bump used ONLY by remounting a quantity display
        // under a changed `key` — that remount is what makes the
        // animation replay on every +/- tap, not a class toggle.
        "qty-pop": {
          "0%": { transform: "scale(1.18)" },
          "100%": { transform: "scale(1)" },
        },
        // A purely decorative sweep inside the camera barcode scanner's
        // viewfinder — never affects the actual video frame @zxing/browser
        // reads, just a visual "it's actively looking" cue on top of it.
        "scan-line": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-up": "slide-up 200ms ease-out",
        "slide-down": "slide-down 200ms ease-out",
        "qty-pop": "qty-pop 150ms ease-out",
        "scan-line": "scan-line 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
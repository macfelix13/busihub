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
        brand: {
          50: "#eefcf3",
          100: "#d6f5e3",
          200: "#afe9cb",
          300: "#7bd8ab",
          400: "#43c088",
          500: "#22a56d",
          600: "#158459",
          700: "#12694a",
          800: "#12533c",
          900: "#104533",
          // Retuned 2026-09-11 to Busihub's exact brand spec (was
          // #06271c) — same role as before (sidebar bg, dashboard hero
          // card, the app's one "primary dark green" surface), just the
          // precise shade the brand guide names. app/globals.css's
          // light-mode --foreground is hand-kept equal to this value —
          // update both together if this ever changes again.
          950: "#082c24",
        },
        // A second, brighter accent used ONLY on top of the dark surfaces
        // above — an active nav icon, a small highlight, a chart's second
        // series, a primary CTA — never as a large fill. Retuned 2026-09-11:
        // this used to be a muted olive-green (400 was #b0d840) rather than
        // the vivid "Busihub Lime Yellow" the brand actually calls for; 400
        // is now the real brand hex, with the rest of the ramp rebuilt
        // around it at the same hue/saturation.
        lime: {
          50: "#f9faf0",
          100: "#f1f3dd",
          200: "#e9f0b2",
          300: "#e8f773",
          400: "#d9f21b",
          500: "#c1d90c",
          600: "#9bae0a",
          700: "#7d8c08",
          800: "#677407",
          900: "#566006",
        },
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
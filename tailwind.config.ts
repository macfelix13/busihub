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
          950: "#06271c",
        },
        // A second, brighter green used ONLY as an accent — an active nav
        // icon, a small highlight, a chart's second series — never as a
        // large fill. brand-950 already carries the dark sidebar/hero-card
        // role on its own; lime is what sits on top of it.
        lime: {
          50: "#f8fce9",
          100: "#eef7c8",
          200: "#ddef98",
          300: "#c7e468",
          400: "#b0d840",
          500: "#94bf29",
          600: "#749a1f",
          700: "#587a1b",
          800: "#48611c",
          900: "#3d521c",
        },
        // The page background behind cards — distinct from card white and
        // from brand-950 (sidebar/hero cards), so the two don't have to
        // share one token doing two jobs.
        canvas: {
          DEFAULT: "#f7f6f2",
          dark: "#0a1a13",
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
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-up": "slide-up 200ms ease-out",
        "slide-down": "slide-down 200ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
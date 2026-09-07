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
      },
      borderRadius: {
        xl: "0.875rem",
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
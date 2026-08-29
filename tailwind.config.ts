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
    },
  },
  plugins: [],
};

export default config;

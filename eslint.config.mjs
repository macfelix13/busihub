// Flat config (ESLint 9+), required by eslint-config-next 16.x — replaces
// the legacy .eslintrc.json this project started with. FlatCompat bridges
// eslint-config-next's shareable configs ("next/core-web-vitals") into the
// flat format; this is the standard pattern Next.js itself generates.
import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
];

export default eslintConfig;

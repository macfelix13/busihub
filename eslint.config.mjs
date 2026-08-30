// Flat config (ESLint 9+). eslint-config-next 16 ships native flat-config
// exports (see its package.json "exports" map: ./core-web-vitals,
// ./typescript) — importing those directly, instead of going through the
// legacy FlatCompat bridge, is what actually fixes the "Converting
// circular structure to JSON" crash: that error came from FlatCompat's
// JSON-schema validation step, which chokes on eslint-plugin-react's
// newer self-referencing flat config objects. Importing the pre-built
// arrays directly never touches that validator.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
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
      ".github/**",
    ],
  },
];

export default eslintConfig;
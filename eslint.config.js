import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Only src/settings may persist data, and only the maintenance interval (docs/PLAN.md, privacy)." },
        { name: "sessionStorage", message: "Only the login module may use it, and only for the PKCE round trip (docs/PLAN.md, privacy)." },
      ],
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Build DOM nodes instead; the CSP forbids inline handlers and data must never be parsed as HTML." },
        { property: "outerHTML", message: "Build DOM nodes instead." },
      ],
    },
  },
  {
    files: ["scripts/**"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off" },
  },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

const STORAGE = "Browser storage is banned everywhere for now; the phase that needs it opens one file and records it in docs/PLAN.md (privacy). Never the access token.";
const HTML = "Build DOM nodes instead: data must never be parsed as HTML and the CSP forbids inline code.";

/** Imports that open a privacy seal; each is allowed in one place only. */
const sealedImport = (name, where) => ({
  regex: "(^|/)sanitize(\\.[cm]?[jt]s)?$",
  importNames: [name],
  message: `${name} is only for ${where} (docs/PLAN.md, privacy).`,
});
const ROUTE_ID_SEAL = sealedImport("serviceRouteId", "the code that requests a route detail, in src/service/");
const TRACE_SEAL = sealedImport("untrimmedLines", "the trim function in src/domain/trim.ts");

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
        { name: "localStorage", message: STORAGE },
        { name: "sessionStorage", message: STORAGE },
      ],
      "no-restricted-properties": [
        "error",
        { property: "localStorage", message: STORAGE },
        { property: "sessionStorage", message: STORAGE },
        { property: "innerHTML", message: HTML },
        { property: "outerHTML", message: HTML },
        { property: "insertAdjacentHTML", message: HTML },
        { property: "createContextualFragment", message: HTML },
        { property: "srcdoc", message: HTML },
        { object: "document", property: "write", message: HTML },
        { object: "document", property: "writeln", message: HTML },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^setAttribute(NS)?$/] > Literal.arguments[value=/^(style|on.+|srcdoc)$/i]",
          message: "Set styles with element.style and listeners with addEventListener: the CSP blocks inline styles and handlers.",
        },
        {
          selector: "CallExpression[callee.name=/^(eval|Function)$/], NewExpression[callee.name='Function']",
          message: "No evaluated code.",
        },
        {
          selector: "ImportExpression",
          message: "No dynamic imports: they slip past the import rules that guard the privacy seals.",
        },
      ],
      "no-restricted-imports": ["error", { patterns: [ROUTE_ID_SEAL, TRACE_SEAL] }],
    },
  },
  {
    files: ["src/service/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [TRACE_SEAL] }] },
  },
  {
    files: ["src/domain/trim.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [ROUTE_ID_SEAL] }] },
  },
  {
    files: ["tests/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["scripts/**"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off" },
  },
);

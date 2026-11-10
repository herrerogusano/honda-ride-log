import js from "@eslint/js";
import tseslint from "typescript-eslint";

const STORAGE = "Browser storage is banned: only src/storage/maintenance.ts may use localStorage, for the two service-interval numbers (docs/PLAN.md, privacy). Never the access token.";
const HTML = "Build DOM nodes instead: data must never be parsed as HTML and the CSP forbids inline code.";

const LOCAL_STORAGE_GLOBAL = { name: "localStorage", message: STORAGE };
const LOCAL_STORAGE_PROPERTY = { property: "localStorage", message: STORAGE };
/** Banned in every file, the storage file included. */
const OTHER_GLOBALS = [{ name: "sessionStorage", message: STORAGE }];
const OTHER_PROPERTIES = [
  { property: "sessionStorage", message: STORAGE },
  { property: "innerHTML", message: HTML },
  { property: "outerHTML", message: HTML },
  { property: "insertAdjacentHTML", message: HTML },
  { property: "createContextualFragment", message: HTML },
  { property: "srcdoc", message: HTML },
  { object: "document", property: "write", message: HTML },
  { object: "document", property: "writeln", message: HTML },
];

/** Imports that open a privacy seal; each is allowed in one place only. */
const sealedImport = (name, where) => ({
  regex: "(^|/)sanitize(\\.[cm]?[jt]s)?$",
  importNames: [name],
  message: `${name} is only for ${where} (docs/PLAN.md, privacy).`,
});
const ROUTE_ID_SEAL = sealedImport("serviceRouteId", "the code that requests a route detail, in src/service/");
const TRACE_SEAL = sealedImport("untrimmedLines", "the trim function in src/domain/trim.ts");
const PLACES_SEAL = sealedImport("sensitivePlaces", "the trim function in src/domain/trim.ts");

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-restricted-globals": ["error", LOCAL_STORAGE_GLOBAL, ...OTHER_GLOBALS],
      "no-restricted-properties": ["error", LOCAL_STORAGE_PROPERTY, ...OTHER_PROPERTIES],
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
      "no-restricted-imports": ["error", { patterns: [ROUTE_ID_SEAL, TRACE_SEAL, PLACES_SEAL] }],
    },
  },
  {
    files: ["src/service/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [TRACE_SEAL, PLACES_SEAL] }] },
  },
  {
    files: ["src/domain/trim.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [ROUTE_ID_SEAL] }] },
  },
  {
    // The one storage exception (docs/PLAN.md, "Privacidad"): this file may
    // use localStorage, and only localStorage. Everything else stays banned.
    files: ["src/storage/maintenance.ts"],
    rules: {
      "no-restricted-globals": ["error", ...OTHER_GLOBALS],
      "no-restricted-properties": ["error", ...OTHER_PROPERTIES],
    },
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

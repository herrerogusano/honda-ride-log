import js from "@eslint/js";
import tseslint from "typescript-eslint";

const STORAGE =
  "Browser storage is banned (docs/PLAN.md, privacy). Three one-file exceptions: src/storage/maintenance.ts may use localStorage for the two service-interval numbers, src/auth/pendingLogin.ts may use sessionStorage for the PKCE verifier and the state, and src/storage/consent.ts may use localStorage for the cookie-notice answer (and document.cookie to delete Google Analytics' cookies). Never the access token.";
const HTML = "Build DOM nodes instead: data must never be parsed as HTML and the CSP forbids inline code.";
const PENDING_LOGIN_STORAGE = "Only the sign-in flow (src/auth/login.ts) may reach sessionStorage through src/auth/pendingLogin.ts (docs/PLAN.md, section 10).";
const CONSENT_STORAGE = "Only the visit counters (src/analytics/tracker.ts) may reach localStorage and cookies through src/storage/consent.ts (docs/PLAN.md, section 17).";
const PENDING_LOGIN_IMPORT = { regex: "(^|/)pendingLogin(\\.[cm]?[jt]s)?(\\?.*)?$", message: PENDING_LOGIN_STORAGE };
const COUNTERS_IMPORT = {
  regex: "(^|/)analytics/(tracker|consentNotice)(\\.[cm]?[jt]s)?(\\?.*)?$",
  message: "Third-party counters are started from src/main.ts only (docs/PLAN.md, section 17).",
};
const CONSENT_IMPORT ={ regex: "(^|/)consent(\\.[cm]?[jt]s)?(\\?.*)?$", message: CONSENT_STORAGE };

const LOCAL_STORAGE_GLOBAL = { name: "localStorage", message: STORAGE };
const LOCAL_STORAGE_PROPERTY = { property: "localStorage", message: STORAGE };
const SESSION_STORAGE_GLOBAL = { name: "sessionStorage", message: STORAGE };
const SESSION_STORAGE_PROPERTY = { property: "sessionStorage", message: STORAGE };
const COOKIE_PROPERTY = { object: "document", property: "cookie", message: STORAGE };
/** Banned in every file, both storage exceptions included. */
const HTML_PROPERTIES = [
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
      "no-restricted-globals": ["error", LOCAL_STORAGE_GLOBAL, SESSION_STORAGE_GLOBAL],
      "no-restricted-properties": ["error", LOCAL_STORAGE_PROPERTY, SESSION_STORAGE_PROPERTY, COOKIE_PROPERTY, ...HTML_PROPERTIES],
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
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name=/^glob/]",
          message: "No import.meta.glob: it loads modules past the import rules that guard the privacy seals.",
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
    // Storage exception 1 (docs/PLAN.md, "Privacidad"): this file may use
    // localStorage, and only localStorage. sessionStorage and the HTML sinks
    // stay banned (tests/lint-storage.test.ts).
    files: ["src/storage/maintenance.ts"],
    rules: {
      "no-restricted-globals": ["error", SESSION_STORAGE_GLOBAL],
      "no-restricted-properties": ["error", SESSION_STORAGE_PROPERTY, COOKIE_PROPERTY, ...HTML_PROPERTIES],
    },
  },
  {
    // Storage exception 3 (docs/PLAN.md, section 17): this file may use
    // localStorage for the answer to the cookie notice, and document.cookie
    // only to delete Google Analytics' cookies. sessionStorage and the HTML
    // sinks stay banned (tests/lint-storage.test.ts).
    files: ["src/storage/consent.ts"],
    rules: {
      "no-restricted-globals": ["error", SESSION_STORAGE_GLOBAL],
      "no-restricted-properties": ["error", SESSION_STORAGE_PROPERTY, ...HTML_PROPERTIES],
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
  {
    // Storage exception 2 (docs/PLAN.md, section 10): this file may use
    // sessionStorage, for the PKCE verifier and the state during the round
    // trip to the login, and only sessionStorage. localStorage and the HTML
    // sinks stay banned (tests/lint-storage.test.ts).
    files: ["src/auth/pendingLogin.ts"],
    rules: {
      "no-restricted-globals": ["error", LOCAL_STORAGE_GLOBAL],
      "no-restricted-properties": ["error", LOCAL_STORAGE_PROPERTY, COOKIE_PROPERTY, ...HTML_PROPERTIES],
    },
  },
  {
    // ...and only the sign-in flow may import that file, so no other module
    // can reach sessionStorage through its helpers. A separate rule id, so the
    // seal rules above stay untouched.
    // The same for the cookie-notice answer: only the visit counters may
    // import src/storage/consent.ts. And the code that loads third-party
    // scripts (src/analytics/tracker.ts, src/analytics/consentNotice.ts) is
    // started from src/main.ts alone, so a page entry that must stay free of
    // them (a sign-in document, docs/PLAN.md section 17) gets none by accident.
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    ignores: ["src/auth/login.ts", "src/auth/pendingLogin.ts", "src/analytics/**", "src/storage/consent.ts", "src/main.ts", "tests/**"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [PENDING_LOGIN_IMPORT, CONSENT_IMPORT, COUNTERS_IMPORT] }] },
  },
  {
    files: ["src/auth/login.ts", "src/auth/pendingLogin.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [CONSENT_IMPORT, COUNTERS_IMPORT] }] },
  },
  {
    files: ["src/main.ts", "src/analytics/**"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [PENDING_LOGIN_IMPORT, CONSENT_IMPORT] }] },
  },
  {
    files: ["src/analytics/tracker.ts", "src/storage/consent.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [PENDING_LOGIN_IMPORT] }] },
  },
);

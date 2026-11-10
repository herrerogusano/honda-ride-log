import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import policy from "./csp.config.json" with { type: "json" };
import environments from "./environments.config.json" with { type: "json" };
import { connectOrigins, parseEnvironment, type ServiceEnvironment } from "./src/service/environment";

/**
 * Content Security Policy of the published page, defined in
 * `csp.config.json`. GitHub Pages cannot send response headers, so the
 * policy travels in a <meta> tag that is injected only in the production
 * build (the dev server needs inline styles and a websocket for hot reload).
 *
 * `scripts/check-dist.mjs` compares the built page with that file, and
 * `tests/csp.test.ts` pins its content: changing the policy means changing
 * the JSON and the test on purpose, with the reason in docs/PLAN.md.
 *
 * The referrer policy is `strict-origin`: OpenStreetMap's tile usage policy
 * requires a Referer, and this sends only the site origin, never the path.
 *
 * When the mode being built has a service configured in
 * `environments.config.json`, the origins of `/mcp` and of the login are
 * appended to `connect-src`, and nothing else changes. Without one, the
 * policy is exactly the file's (docs/PLAN.md, section 10).
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = policy.directives;
export const REFERRER_POLICY: string = policy.referrer;

/** The policy for a build of `environment`. */
export function directivesFor(environment: ServiceEnvironment): Record<string, readonly string[]> {
  const directives: Record<string, readonly string[]> = { ...CSP_DIRECTIVES };
  const extra = connectOrigins(environment);
  if (extra.length > 0) directives["connect-src"] = [...(CSP_DIRECTIVES["connect-src"] ?? []), ...extra];
  return directives;
}

export function cspContent(directives: Readonly<Record<string, readonly string[]>> = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** The entry of `environments.config.json` for a Vite mode, validated; modes not listed are demo only. */
export function environmentFor(mode: string): { raw: unknown; environment: ServiceEnvironment } {
  const raw = Object.hasOwn(environments, mode) ? (environments as Record<string, unknown>)[mode] : null;
  return { raw: raw ?? null, environment: parseEnvironment(raw) };
}

function cspMeta(environment: ServiceEnvironment): Plugin {
  return {
    name: "ride-log-csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: cspContent(directivesFor(environment)) },
          injectTo: "head-prepend",
        },
        { tag: "meta", attrs: { name: "referrer", content: REFERRER_POLICY }, injectTo: "head-prepend" },
      ];
    },
  };
}

export default defineConfig(({ command, mode, isPreview }) => {
  // Throws on a half-filled or malformed entry, so a bad build never ships.
  const { raw, environment } = environmentFor(mode);
  return {
    // Published at https://<user>.github.io/honda-ride-log/ (and previewed
    // there). The dev server serves at the root instead, because the login
    // sends the browser back to exactly http://localhost:5173/ (port fixed,
    // `localhost` only, never 127.0.0.1).
    base: command === "build" || isPreview === true ? "/honda-ride-log/" : "/",
    server: { host: "localhost", port: 5173, strictPort: true },
    plugins: [cspMeta(environment)],
    // The validated entry of this mode, read by `currentEnvironment()`.
    define: { __RIDE_LOG_SERVICE__: JSON.stringify(raw) },
    build: { sourcemap: false, assetsInlineLimit: 0 },
    test: {
      include: ["tests/**/*.test.ts"],
      environment: "node",
      // Tests run far from UTC on purpose, so code that slips into local time
      // gives a different answer than the pinned UTC expectations.
      env: { TZ: "America/Los_Angeles" },
    },
  };
});

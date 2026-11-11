import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import policy from "./csp.config.json" with { type: "json" };
import analyticsFile from "./analytics.config.json" with { type: "json" };
import environments from "./environments.config.json" with { type: "json" };
import { NO_ANALYTICS, parseAnalytics, type AnalyticsConfig } from "./src/analytics/config";
import { connectOrigins, parseEnvironment, type ServiceEnvironment } from "./src/service/environment";

/**
 * Content Security Policy of the published page, defined in
 * `csp.config.json`. It travels in a <meta> tag injected in every build
 * (the dev server has none: it needs inline styles and a websocket for hot
 * reload). GitHub Pages cannot send response headers; Cloudflare Pages can,
 * so the `cloudflare` build also writes `dist/_headers` with the same policy
 * plus `frame-ancestors 'none'` (which a <meta> tag cannot carry) and the
 * other headers of `csp.config.json` (docs/PLAN.md, section 17). The <meta>
 * tag stays as well: a browser enforces both, so a missing or mistyped
 * `_headers` never leaves the page without a policy.
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
 * policy is exactly the file's (docs/PLAN.md, section 10). Likewise each
 * visit counter set in `analytics.config.json` adds its own origins, listed
 * under `analytics` in `csp.config.json`; with none set, nothing is added.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = policy.directives;
export const REFERRER_POLICY: string = policy.referrer;

export const HEADER_ONLY_DIRECTIVES: Readonly<Record<string, readonly string[]>> = policy.headerOnly;
export const SECURITY_HEADERS: Readonly<Record<string, string>> = policy.headers;
type Sources = Readonly<Record<string, readonly string[]>>;
export const ANALYTICS_SOURCES: Readonly<{ cloudflare: Sources; google: Sources }> = policy.analytics;

function add(directives: Record<string, readonly string[]>, extra: Sources): void {
  for (const [name, values] of Object.entries(extra)) {
    const current = directives[name] ?? [];
    directives[name] = [...current, ...values.filter((value) => !current.includes(value))];
  }
}

/** The policy for a build of `environment` with the counters of `analytics`. */
export function directivesFor(environment: ServiceEnvironment, analytics: AnalyticsConfig = NO_ANALYTICS): Record<string, readonly string[]> {
  const directives: Record<string, readonly string[]> = { ...CSP_DIRECTIVES };
  const extra = connectOrigins(environment);
  if (extra.length > 0) directives["connect-src"] = [...(CSP_DIRECTIVES["connect-src"] ?? []), ...extra];
  if (analytics.cloudflareToken !== null) add(directives, ANALYTICS_SOURCES.cloudflare);
  if (analytics.googleMeasurementId !== null) add(directives, ANALYTICS_SOURCES.google);
  return directives;
}

/** Where a mode is published. Modes not listed are built for GitHub Pages. */
export interface Host {
  readonly base: string;
  /** Write `dist/_headers` (Cloudflare Pages reads it; GitHub Pages cannot). */
  readonly headersFile: boolean;
}
const GITHUB_PAGES: Host = { base: "/honda-ride-log/", headersFile: false };
const CLOUDFLARE_PAGES: Host = { base: "/", headersFile: true };
export const hostFor = (mode: string): Host => (mode === "cloudflare" ? CLOUDFLARE_PAGES : GITHUB_PAGES);

/** The counters of `analytics.config.json` for a Vite mode, validated; modes not listed have none. */
export function analyticsFor(mode: string): { raw: unknown; analytics: AnalyticsConfig } {
  const listed = mode !== "$comment" && Object.hasOwn(analyticsFile, mode);
  const raw = listed ? (analyticsFile as Record<string, unknown>)[mode] : null;
  return { raw: raw ?? null, analytics: parseAnalytics(raw) };
}

/** The `_headers` file of Cloudflare Pages: every response gets the policy and the other headers. */
export function headersFile(directives: Readonly<Record<string, readonly string[]>>): string {
  const lines = [
    "/*",
    `  Content-Security-Policy: ${cspContent({ ...directives, ...HEADER_ONLY_DIRECTIVES })}`,
    `  Referrer-Policy: ${REFERRER_POLICY}`,
    ...Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`),
  ];
  return `${lines.join("\n")}\n`;
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

function cspMeta(directives: Readonly<Record<string, readonly string[]>>, host: Host): Plugin {
  return {
    name: "ride-log-csp-meta",
    apply: "build",
    generateBundle() {
      if (host.headersFile) this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(directives) });
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: cspContent(directives) },
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
  const { raw: rawAnalytics, analytics } = analyticsFor(mode);
  const host = hostFor(mode);
  return {
    // `production` is published at https://<user>.github.io/honda-ride-log/
    // and `cloudflare` at the root of its pages.dev address (each previewed
    // the same way). The dev server serves at the root, because the login
    // sends the browser back to exactly http://localhost:5173/ (port fixed,
    // `localhost` only, never 127.0.0.1).
    base: command === "build" || isPreview === true ? host.base : "/",
    server: { host: "localhost", port: 5173, strictPort: true },
    plugins: [cspMeta(directivesFor(environment, analytics), host)],
    // The validated entries of this mode, read by `currentEnvironment()` and `currentAnalytics()`.
    define: { __RIDE_LOG_SERVICE__: JSON.stringify(raw), __RIDE_LOG_ANALYTICS__: JSON.stringify(rawAnalytics) },
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

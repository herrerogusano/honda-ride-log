import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import policy from "./csp.config.json" with { type: "json" };

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
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = policy.directives;
export const REFERRER_POLICY: string = policy.referrer;

export function cspContent(directives = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

function cspMeta(): Plugin {
  return {
    name: "ride-log-csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: cspContent() },
          injectTo: "head-prepend",
        },
        { tag: "meta", attrs: { name: "referrer", content: REFERRER_POLICY }, injectTo: "head-prepend" },
      ];
    },
  };
}

export default defineConfig({
  // Published at https://<user>.github.io/honda-ride-log/
  base: "/honda-ride-log/",
  plugins: [cspMeta()],
  build: { sourcemap: false, assetsInlineLimit: 0 },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests run far from UTC on purpose, so code that slips into local time
    // gives a different answer than the pinned UTC expectations.
    env: { TZ: "America/Los_Angeles" },
  },
});

import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Content Security Policy of the published page. GitHub Pages cannot send
 * response headers, so the policy travels in a <meta> tag that is injected
 * only in the production build (the dev server needs inline styles and a
 * websocket for hot reload).
 *
 * Phase 3 adds the service and login origins to `connect-src` from the
 * per-environment configuration. Nothing else should be loosened without a
 * written reason in docs/PLAN.md.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "img-src": ["'self'", "https://tile.openstreetmap.org"],
  "connect-src": ["'self'"],
  "font-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
};

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
        { tag: "meta", attrs: { name: "referrer", content: "no-referrer" }, injectTo: "head-prepend" },
      ];
    },
  };
}

export default defineConfig({
  // Published at https://<user>.github.io/honda-ride-log/
  base: "/honda-ride-log/",
  plugins: [cspMeta()],
  build: { sourcemap: false, assetsInlineLimit: 0 },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});

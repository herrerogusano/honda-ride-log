import { describe, expect, it } from "vitest";
import { DEMO_ONLY, parseEnvironment } from "../src/service/environment";
import {
  ANALYTICS_SOURCES,
  CSP_DIRECTIVES,
  cspContent,
  directivesFor,
  analyticsFor,
  environmentFor,
  HEADER_ONLY_DIRECTIVES,
  headersFile,
  hostFor,
  REFERRER_POLICY,
  SECURITY_HEADERS,
} from "../vite.config";

describe("content security policy", () => {
  it("is exactly the policy written here", () => {
    // Pinned on purpose. To change the policy, change csp.config.json AND
    // this text, and write the reason in docs/PLAN.md. This is also the
    // policy of every demo-only build; a build with a service configured adds
    // two origins to connect-src (next test, and docs/PLAN.md section 10).
    expect(cspContent()).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; " +
        "font-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });

  it("loads fonts from this site only: the files in src/assets/fonts (docs/PLAN.md, D-025)", () => {
    expect(CSP_DIRECTIVES["font-src"]).toEqual(["'self'"]);
  });

  it("never allows inline or evaluated code, wildcards or plain http", () => {
    const sources = Object.values(CSP_DIRECTIVES).flat();
    for (const source of sources) {
      expect(source).not.toMatch(/unsafe|\*|^http:|^data:|^blob:|^https:$/);
    }
    expect(CSP_DIRECTIVES["script-src"]).toEqual(["'self'"]);
  });

  it("lets a configured build connect to the service and login origins only, changing nothing else", () => {
    const configured = directivesFor(
      parseEnvironment({
        mcpUrl: "https://api.example.test/mcp",
        loginDomain: "https://login.example.test",
        webClientId: "synthetic-client-id",
        redirectUri: "https://example.test/",
      }),
    );
    expect(configured["connect-src"]).toEqual(["'self'", "https://api.example.test", "https://login.example.test"]);
    expect({ ...configured, "connect-src": CSP_DIRECTIVES["connect-src"] }).toEqual(CSP_DIRECTIVES);
    for (const source of Object.values(configured).flat()) expect(source).not.toMatch(/unsafe|\*|^http:|^data:|^blob:|^https:$/);
  });

  it("stays exactly the file's policy, connect-src 'self' only, without a service", () => {
    expect(directivesFor(DEMO_ONLY)).toEqual(CSP_DIRECTIVES);
    expect(directivesFor(DEMO_ONLY)["connect-src"]).toEqual(["'self'"]);
    // Every mode of environments.config.json that has no service is the same.
    for (const mode of ["demo", "test", "not-a-mode"]) expect(cspContent(directivesFor(environmentFor(mode).environment))).toBe(cspContent());
  });

  it("adds origins only, never the path, the port twice or the same origin twice", () => {
    const sameHost = directivesFor(
      parseEnvironment({
        mcpUrl: "https://auth.example.test:8443/prod/mcp",
        loginDomain: "https://auth.example.test:8443",
        webClientId: "synthetic-client-id",
        redirectUri: "https://example.test/",
      }),
    );
    expect(sameHost["connect-src"]).toEqual(["'self'", "https://auth.example.test:8443"]);
    const twoHosts = directivesFor(
      parseEnvironment({
        mcpUrl: "https://api.example.test/prod/mcp",
        loginDomain: "https://login.example.test/",
        webClientId: "synthetic-client-id",
        redirectUri: "https://example.test/",
      }),
    );
    expect(cspContent(twoHosts)).toContain("connect-src 'self' https://api.example.test https://login.example.test;");
    expect(cspContent(twoHosts)).not.toContain("/prod");
  });

  it("sends only the site origin as referrer, which map tiles require", () => {
    expect(REFERRER_POLICY).toBe("strict-origin");
  });

  it("allows exactly these origins for each visit counter, and only when it is configured (docs/PLAN.md, section 17)", () => {
    expect(ANALYTICS_SOURCES).toEqual({
      cloudflare: { "script-src": ["https://static.cloudflareinsights.com"], "connect-src": ["https://cloudflareinsights.com"] },
      google: {
        "script-src": ["https://www.googletagmanager.com"],
        "img-src": ["https://www.googletagmanager.com", "https://www.google-analytics.com"],
        "connect-src": [
          "https://www.googletagmanager.com",
          "https://www.google-analytics.com",
          "https://region1.google-analytics.com",
          "https://region1.analytics.google.com",
        ],
      },
    });
    const none = { cloudflareToken: null, googleMeasurementId: null };
    expect(directivesFor(DEMO_ONLY, none)).toEqual(CSP_DIRECTIVES);
    expect(cspContent(directivesFor(DEMO_ONLY, { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: null }))).toBe(
      "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org; connect-src 'self' https://cloudflareinsights.com; " +
        "font-src 'self'; base-uri 'none'; form-action 'none'",
    );
    const both = directivesFor(DEMO_ONLY, { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" });
    expect(cspContent(both)).toBe(
      "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com https://www.googletagmanager.com; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org https://www.googletagmanager.com https://www.google-analytics.com; " +
        "connect-src 'self' https://cloudflareinsights.com https://www.googletagmanager.com https://www.google-analytics.com " +
        "https://region1.google-analytics.com https://region1.analytics.google.com; " +
        "font-src 'self'; base-uri 'none'; form-action 'none'",
    );
    for (const source of Object.values(both).flat()) expect(source).not.toMatch(/unsafe|\*|^http:|^data:|^blob:|^https:$/);
  });

  it("publishes Cloudflare Pages at the root with real headers, and GitHub Pages as before", () => {
    expect(hostFor("cloudflare")).toEqual({ base: "/", headersFile: true });
    for (const mode of ["production", "development", "demo", "test"]) expect(hostFor(mode)).toEqual({ base: "/honda-ride-log/", headersFile: false });
    expect(HEADER_ONLY_DIRECTIVES).toEqual({ "frame-ancestors": ["'none'"] });
    expect(headersFile(CSP_DIRECTIVES)).toBe(
      "/*\n" +
        "  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; font-src 'self'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'\n" +
        "  Referrer-Policy: strict-origin\n" +
        "  X-Content-Type-Options: nosniff\n" +
        "  X-Frame-Options: DENY\n" +
        "  Cross-Origin-Opener-Policy: same-origin\n" +
        "  Cross-Origin-Resource-Policy: same-origin\n" +
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()\n",
    );
    expect(Object.keys(SECURITY_HEADERS)).not.toContain("Content-Security-Policy");
  });

  it("lets no other third party in: with everything switched on, these are all the foreign origins", () => {
    const everything = directivesFor(
      parseEnvironment({
        mcpUrl: "https://api.example.test/mcp",
        loginDomain: "https://login.example.test",
        webClientId: "synthetic-client-id",
        redirectUri: "https://example.test/",
      }),
      { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" },
    );
    const foreign = [...new Set(Object.values({ ...everything, ...HEADER_ONLY_DIRECTIVES }).flat().filter((source) => !source.startsWith("'")))].sort();
    expect(foreign).toEqual([
      // The service of the build (synthetic here).
      "https://api.example.test",
      "https://cloudflareinsights.com",
      "https://login.example.test",
      "https://region1.analytics.google.com",
      "https://region1.google-analytics.com",
      "https://static.cloudflareinsights.com",
      "https://tile.openstreetmap.org",
      "https://www.google-analytics.com",
      "https://www.googletagmanager.com",
    ]);
    // Nothing foreign may run as a script but the two counters, nor be framed, styled or used as a font.
    expect(everything["script-src"]).toEqual(["'self'", "https://static.cloudflareinsights.com", "https://www.googletagmanager.com"]);
    for (const directive of ["default-src", "style-src", "font-src", "base-uri", "form-action"]) expect(everything[directive]).toEqual(CSP_DIRECTIVES[directive]);
    expect(everything["frame-src"]).toBeUndefined();
    expect(Object.keys(ANALYTICS_SOURCES)).toEqual(["cloudflare", "google"]);
  });

  it("writes exactly these headers for the Cloudflare Pages build as configured (demo only, Google's id, no Cloudflare token)", () => {
    const directives = directivesFor(environmentFor("cloudflare").environment, analyticsFor("cloudflare").analytics);
    expect(headersFile(directives)).toBe(
      "/*\n" +
        "  Content-Security-Policy: default-src 'none'; script-src 'self' https://www.googletagmanager.com; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org https://www.googletagmanager.com https://www.google-analytics.com; " +
        "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://region1.google-analytics.com " +
        "https://region1.analytics.google.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n" +
        "  Referrer-Policy: strict-origin\n" +
        "  X-Content-Type-Options: nosniff\n" +
        "  X-Frame-Options: DENY\n" +
        "  Cross-Origin-Opener-Policy: same-origin\n" +
        "  Cross-Origin-Resource-Policy: same-origin\n" +
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()\n",
    );
  });
});

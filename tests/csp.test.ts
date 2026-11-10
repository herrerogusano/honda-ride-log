import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/service/environment";
import { CSP_DIRECTIVES, cspContent, directivesFor, REFERRER_POLICY } from "../vite.config";

describe("content security policy", () => {
  it("is exactly the policy written here", () => {
    // Pinned on purpose. To change the policy, change csp.config.json AND
    // this text, and write the reason in docs/PLAN.md. This is also the
    // policy of every demo-only build; a build with a service configured adds
    // two origins to connect-src (next test, and docs/PLAN.md section 10).
    expect(cspContent()).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; " +
        "font-src 'none'; base-uri 'none'; form-action 'none'",
    );
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

  it("sends only the site origin as referrer, which map tiles require", () => {
    expect(REFERRER_POLICY).toBe("strict-origin");
  });
});

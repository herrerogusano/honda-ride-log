import { describe, expect, it } from "vitest";
import { CSP_DIRECTIVES, cspContent, REFERRER_POLICY } from "../vite.config";

describe("content security policy", () => {
  it("is exactly the policy written here", () => {
    // Pinned on purpose. To change the policy, change csp.config.json AND
    // this text, and write the reason in docs/PLAN.md. Phase 3 will add the
    // service and login origins to connect-src.
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

  it("sends only the site origin as referrer, which map tiles require", () => {
    expect(REFERRER_POLICY).toBe("strict-origin");
  });
});

import { describe, expect, it } from "vitest";
import { CSP_DIRECTIVES, cspContent } from "../vite.config";

describe("content security policy", () => {
  it("denies by default and never allows inline or evaluated code", () => {
    const policy = cspContent();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("only reaches third parties for OpenStreetMap tiles", () => {
    const external = Object.values(CSP_DIRECTIVES)
      .flat()
      .filter((value) => value.includes(":") );
    expect(external).toEqual(["https://tile.openstreetmap.org"]);
  });
});

import { describe, expect, it } from "vitest";
import environments from "../environments.config.json" with { type: "json" };
import { connectOrigins, currentEnvironment, EnvironmentError, parseEnvironment } from "../src/service/environment";
import { cspContent, directivesFor, environmentFor } from "../vite.config";

/** Synthetic values only. */
const FILLED = {
  mcpUrl: "https://api.example.test/mcp",
  loginDomain: "https://login.example.test",
  webClientId: "synthetic-client-id",
  redirectUri: "http://localhost:5173/",
  logoutUri: "",
  sendResourceIndicator: true,
};

function rejects(entry: unknown, field: RegExp) {
  expect(() => parseEnvironment(entry)).toThrow(EnvironmentError);
  expect(() => parseEnvironment(entry)).toThrow(field);
}

describe("environment file", () => {
  it("holds no real deployment yet: every mode is demo only", () => {
    // When the owner fills a real entry, this test changes on purpose.
    for (const mode of ["demo", "development", "production", "test"]) {
      expect(environmentFor(mode).environment).toEqual({ kind: "demo" });
    }
    expect(currentEnvironment()).toEqual({ kind: "demo" });
  });

  it("keeps the two return addresses the login will expect", () => {
    expect(environments.development.redirectUri).toBe("http://localhost:5173/");
    expect(environments.production.redirectUri).toBe("https://herrerogusano.github.io/honda-ride-log/");
  });
});

describe("parseEnvironment", () => {
  it("reads a complete entry", () => {
    expect(parseEnvironment(FILLED)).toEqual({
      kind: "service",
      config: {
        mcpUrl: "https://api.example.test/mcp",
        loginOrigin: "https://login.example.test",
        webClientId: "synthetic-client-id",
        redirectUri: "http://localhost:5173/",
        logoutUri: null,
        sendResourceIndicator: true,
      },
    });
  });

  it("gives demo only for null or for empty service values", () => {
    expect(parseEnvironment(null)).toEqual({ kind: "demo" });
    expect(parseEnvironment({ ...FILLED, mcpUrl: "", loginDomain: " ", webClientId: "" })).toEqual({ kind: "demo" });
  });

  it("accepts the login origin with or without the final slash", () => {
    const parsed = parseEnvironment({ ...FILLED, loginDomain: "https://login.example.test/" });
    expect(parsed.kind === "service" && parsed.config.loginOrigin).toBe("https://login.example.test");
  });

  it.each([
    ["a half-filled entry", { ...FILLED, webClientId: "" }, /all filled or all empty/],
    ["plain http for the service", { ...FILLED, mcpUrl: "http://api.example.test/mcp" }, /mcpUrl must be an https URL/],
    ["a query in the service address", { ...FILLED, mcpUrl: "https://api.example.test/mcp?x=1" }, /mcpUrl must be a URL without query/],
    ["an empty query in the service address", { ...FILLED, mcpUrl: "https://api.example.test/mcp?" }, /mcpUrl must be a URL without query/],
    ["a trailing slash in the service address", { ...FILLED, mcpUrl: "https://api.example.test/mcp/" }, /mcpUrl must be written in canonical form/],
    ["credentials in an address", { ...FILLED, mcpUrl: "https://user:pw@api.example.test/mcp" }, /without credentials/],
    ["a path in the login domain", { ...FILLED, loginDomain: "https://login.example.test/oauth2" }, /loginDomain must be an origin only/],
    ["a non-URL", { ...FILLED, loginDomain: "login.example.test" }, /loginDomain must be an absolute URL/],
    ["an odd client id", { ...FILLED, webClientId: "id with spaces" }, /webClientId/],
    ["127.0.0.1 as return address", { ...FILLED, redirectUri: "http://127.0.0.1:5173/" }, /redirectUri must be an https URL or http:\/\/localhost/],
    ["a return address without the final slash", { ...FILLED, redirectUri: "http://localhost:5173" }, /redirectUri must be written in canonical form/],
    ["no return address", { ...FILLED, redirectUri: "" }, /redirectUri must be filled/],
    ["a fragment in the return address", { ...FILLED, redirectUri: "https://example.test/#x" }, /without query or fragment/],
    ["a non-boolean resource switch", { ...FILLED, sendResourceIndicator: "yes" }, /sendResourceIndicator/],
    ["an unknown field", { ...FILLED, clientSecret: "x" }, /clientSecret must be one of the known fields/],
    ["a list", [], /the entry/],
    ["plain http for the login", { ...FILLED, loginDomain: "http://login.example.test" }, /loginDomain must be an https URL/],
    ["plain http for the login, even on localhost", { ...FILLED, loginDomain: "http://localhost:8080" }, /loginDomain must be an https URL/],
    ["an upper-case host in the service address", { ...FILLED, mcpUrl: "https://API.example.test/mcp" }, /mcpUrl must be written in canonical form/],
    ["a default port written out", { ...FILLED, mcpUrl: "https://api.example.test:443/mcp" }, /mcpUrl must be written in canonical form/],
    ["an upper-case login domain", { ...FILLED, loginDomain: "https://LOGIN.example.test" }, /loginDomain must be an origin only/],
    ["a default port in the login domain", { ...FILLED, loginDomain: "https://login.example.test:443" }, /loginDomain must be an origin only/],
    ["127.0.0.1 as sign-out address", { ...FILLED, logoutUri: "http://127.0.0.1:5173/" }, /logoutUri must be an https URL or http:\/\/localhost/],
    ["a query in the sign-out address", { ...FILLED, logoutUri: "https://example.test/?next=x" }, /logoutUri must be a URL without query/],
  ])("refuses %s", (_label, entry, message) => rejects(entry, message));

  it("reads a sign-out address", () => {
    const parsed = parseEnvironment({ ...FILLED, logoutUri: "https://example.test/out/" });
    expect(parsed.kind === "service" && parsed.config.logoutUri).toBe("https://example.test/out/");
  });

  it("sends the resource indicator unless told not to", () => {
    const withoutSwitch: Record<string, unknown> = { ...FILLED };
    delete withoutSwitch["sendResourceIndicator"];
    const parsed = parseEnvironment(withoutSwitch);
    expect(parsed.kind === "service" && parsed.config.sendResourceIndicator).toBe(true);
    const off = parseEnvironment({ ...FILLED, sendResourceIndicator: false });
    expect(off.kind === "service" && off.config.sendResourceIndicator).toBe(false);
  });

  it("never puts a value in its error message", () => {
    const secretish = "https://user:hunter2@api.example.test/mcp";
    expect(() => parseEnvironment({ ...FILLED, mcpUrl: secretish })).toThrow(/^(?!.*hunter2)/s);
  });
});

describe("security policy per environment", () => {
  it("adds only the service and login origins to connect-src, and only when configured", () => {
    const service = parseEnvironment(FILLED);
    expect(connectOrigins(service)).toEqual(["https://api.example.test", "https://login.example.test"]);
    expect(cspContent(directivesFor(service))).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "img-src 'self' https://tile.openstreetmap.org; " +
        "connect-src 'self' https://api.example.test https://login.example.test; " +
        "font-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(cspContent(directivesFor({ kind: "demo" }))).toBe(cspContent());
  });

  it("lists a shared origin once", () => {
    const same = parseEnvironment({ ...FILLED, loginDomain: "https://api.example.test" });
    expect(connectOrigins(same)).toEqual(["https://api.example.test"]);
  });

  it("fails the build of a mode with a malformed entry", () => {
    expect(() => parseEnvironment({ ...FILLED, mcpUrl: "https://*.example.test/mcp" })).toThrow(EnvironmentError);
  });
});

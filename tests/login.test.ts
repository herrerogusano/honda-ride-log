// Runs in Node against tests/fakeServer.ts. It proves the PKCE round trip as
// we read the login's contract, not that Cognito or its CORS behave this way.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthError, authorizeUrl, browserDeps, completeLogin, logout, resumeSession, startLogin, takeLogoutNotice, type AuthDeps } from "../src/auth/login";
import { PENDING_LOGIN_TTL_MS, type StorageLike } from "../src/auth/pendingLogin";
import { EXPIRY_MARGIN_MS } from "../src/auth/session";

/** The one entry that src/auth/savedSession.ts keeps in the tab. */
const SAVED_KEY = "ride-log.session";
import { createFakeServer, TEST_CONFIG, type FakeServer } from "./fakeServer";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

interface Browser {
  deps: AuthDeps;
  storage: MemoryStorage;
  address: { href: string };
  navigations: string[];
  replacements: string[];
}

function browser(server: FakeServer, start = "http://localhost:5173/"): Browser {
  const storage = new MemoryStorage();
  const address = { href: start };
  const navigations: string[] = [];
  const replacements: string[] = [];
  return {
    storage,
    address,
    navigations,
    replacements,
    deps: {
      crypto: webcrypto as unknown as AuthDeps["crypto"],
      storage,
      fetch: server.fetch,
      currentUrl: () => address.href,
      replaceUrl: (url) => {
        replacements.push(url);
        address.href = url;
      },
      navigate: (url) => navigations.push(url),
      now: () => server.clock.now,
    },
  };
}

/** Start the login, let the fake login approve it and land back on the page. */
async function roundTrip(server: FakeServer, b: Browser): Promise<string> {
  await startLogin(TEST_CONFIG, b.deps);
  const back = server.approve(b.navigations.at(-1) ?? "");
  b.address.href = back;
  return back;
}

async function authError(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AuthError);
  return error as AuthError;
}

describe("authorization request", () => {
  it("asks for a code with PKCE S256, the exact return address, both scopes and the resource", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    expect(b.navigations).toHaveLength(1);
    const url = new URL(b.navigations[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://login.example.test/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "synthetic-client-id",
      redirect_uri: "http://localhost:5173/",
      scope: "openid https://api.example.test/mcp/use",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
      resource: "https://api.example.test/mcp",
    });
  });

  it("asks the managed login for Spanish only for the open service; the invitation request has no lang", () => {
    const open = { ...TEST_CONFIG, logoutUri: "http://localhost:5173/", publicAccess: { statusUrl: "https://api.example.test/estado", passUrl: "https://api.example.test/pase", turnstileSiteKey: "0x4AAAAAAASyntheticKey" } };
    expect(new URL(authorizeUrl(open, "s".repeat(43), "c".repeat(43))).searchParams.get("lang")).toBe("es");
    expect(new URL(authorizeUrl(TEST_CONFIG, "s".repeat(43), "c".repeat(43))).searchParams.has("lang")).toBe(false);
  });

  it("leaves out the resource when the configuration says so", () => {
    const url = new URL(authorizeUrl({ ...TEST_CONFIG, sendResourceIndicator: false }, "s".repeat(43), "c".repeat(43)));
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("keeps only the verifier and the state in session storage, never the challenge", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    expect(b.storage.items.size).toBe(1);
    const stored = JSON.parse([...b.storage.items.values()][0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["createdAt", "state", "verifier"]);
    const sent = new URL(b.navigations[0] ?? "").searchParams;
    expect(stored["state"]).toBe(sent.get("state"));
    expect(stored["verifier"]).not.toBe(sent.get("code_challenge"));
  });

  it("uses a new verifier and state every time", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    await startLogin(TEST_CONFIG, b.deps);
    const [first, second] = b.navigations.map((url) => new URL(url).searchParams);
    expect(first?.get("state")).not.toBe(second?.get("state"));
    expect(first?.get("code_challenge")).not.toBe(second?.get("code_challenge"));
  });

  it("refuses without configuration or without session storage, before leaving the page", async () => {
    const server = createFakeServer();
    const b = browser(server);
    expect((await authError(startLogin(null, b.deps))).kind).toBe("config_missing");
    expect((await authError(startLogin(TEST_CONFIG, { ...b.deps, storage: null }))).kind).toBe("storage_unavailable");
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect((await authError(startLogin(TEST_CONFIG, { ...b.deps, storage: throwing }))).kind).toBe("storage_unavailable");
    expect(b.navigations).toEqual([]);
  });
});

describe("return from the login", () => {
  it("trades the code for a session and keeps only the access token", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const result = await completeLogin(TEST_CONFIG, b.deps);
    expect(result.status).toBe("signed_in");
    if (result.status !== "signed_in") return;
    expect(result.session.authorization(server.clock.now)).toBe(`Bearer ${server.issuedTokens[0]}`);
    // Neither the token nor the refresh or ID token is readable from the session object.
    const visible = JSON.stringify(result.session) + String(Object.keys(result.session));
    for (const token of [...server.issuedTokens, ...server.otherTokens]) expect(visible).not.toContain(token);
    // After the return the tab keeps one entry: the access token and its expiry, nothing else.
    expect([...b.storage.items.keys()]).toEqual([SAVED_KEY]);
    const saved = JSON.parse(b.storage.items.get(SAVED_KEY) ?? "") as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["binding", "expiresAt", "token"]);
    expect(saved["token"]).toBe(server.issuedTokens[0]);
    // The binding of the account data is random, not made from the token.
    expect(saved["binding"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.issuedTokens[0]).not.toContain(saved["binding"] as string);
    for (const token of server.otherTokens) expect(b.storage.items.get(SAVED_KEY)).not.toContain(token);
  });

  it("sends the verifier, the code and the same return address to the token endpoint, without cookies", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    await completeLogin(TEST_CONFIG, b.deps);
    const token = server.requests.find((request) => request.url.endsWith("/oauth2/token"));
    expect(token?.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(token?.init.signal).toBeInstanceOf(AbortSignal);
    const form = new URLSearchParams(token?.body);
    expect(form.get("redirect_uri")).toBe("http://localhost:5173/");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.has("client_secret")).toBe(false);
  });

  it("removes code and state from the address before the exchange, keeping the rest", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    b.address.href = b.address.href.replace("?", "?tab=mapa&") + "#rutas";
    let addressDuringExchange = "";
    const deps: AuthDeps = {
      ...b.deps,
      fetch: (input, init) => {
        addressDuringExchange = b.address.href;
        return server.fetch(input, init);
      },
    };
    await completeLogin(TEST_CONFIG, deps);
    expect(addressDuringExchange).toBe("http://localhost:5173/?tab=mapa#rutas");
    expect(b.replacements).toEqual(["http://localhost:5173/?tab=mapa#rutas"]);
  });

  it("does nothing on a normal visit", async () => {
    const server = createFakeServer();
    const b = browser(server, "http://localhost:5173/?tab=mapa");
    await startLogin(TEST_CONFIG, b.deps);
    expect(await completeLogin(TEST_CONFIG, b.deps)).toEqual({ status: "none" });
    expect(b.replacements).toEqual([]);
    expect(b.storage.items.size).toBe(1);
    expect(server.requests).toEqual([]);
  });

  it("rejects another state, and clears the pending login and the address anyway", async () => {
    const server = createFakeServer();
    const b = browser(server);
    const back = new URL(await roundTrip(server, b));
    back.searchParams.set("state", "A".repeat(43));
    b.address.href = back.href;
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("state_mismatch");
    expect(b.address.href).toBe("http://localhost:5173/");
    expect(b.storage.items.size).toBe(0);
    expect(server.requests).toEqual([]);
  });

  it("rejects a return with no pending login (another tab, a reload, a forged link)", async () => {
    const server = createFakeServer();
    const b = browser(server);
    const back = await roundTrip(server, b);
    b.storage.items.clear();
    b.address.href = back;
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("state_mismatch");
    expect(server.requests).toEqual([]);
  });

  it("rejects a pending login older than ten minutes", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    server.clock.now += PENDING_LOGIN_TTL_MS + 1;
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("state_mismatch");
  });

  it("cannot use the same return twice", async () => {
    const server = createFakeServer();
    const b = browser(server);
    const back = await roundTrip(server, b);
    await completeLogin(TEST_CONFIG, b.deps);
    b.address.href = back;
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("state_mismatch");
  });

  it("reports an error from the login page by its code only", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    const state = new URL(b.navigations[0] ?? "").searchParams.get("state") ?? "";
    b.address.href = `http://localhost:5173/?error=access_denied&error_description=User+said+no&state=${state}`;
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["login_failed", "access_denied"]);
    expect(error.message).not.toContain("User");
    expect(b.address.href).toBe("http://localhost:5173/");
  });

  it("checks the state before believing an error from the login page", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    b.address.href = `http://localhost:5173/?error=access_denied&state=${"A".repeat(43)}`;
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("state_mismatch");
  });

  it.each([
    ["an empty code", ""],
    ["a code longer than 2048 characters", "c".repeat(2049)],
  ])("refuses %s without calling the token endpoint", async (_label, code) => {
    const server = createFakeServer();
    const b = browser(server);
    const back = new URL(await roundTrip(server, b));
    back.searchParams.set("code", code);
    b.address.href = back.href;
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["login_failed", "missing_code"]);
    expect(server.requests).toEqual([]);
  });

  it("reports blocked storage on the return as such, not as an unknown failure", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect((await authError(completeLogin(TEST_CONFIG, { ...b.deps, storage: blocked }))).kind).toBe("storage_unavailable");
    expect(b.address.href).toBe("http://localhost:5173/");
  });

  it("gives up on a token endpoint that never answers", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const neverAnswers: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const error = await authError(completeLogin(TEST_CONFIG, { ...b.deps, fetch: neverAnswers, timeoutMs: 20 }));
    expect(error.kind).toBe("token_network");
  });

  it("gives up on a token answer whose body never ends", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const stalls: typeof fetch = async (_input, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const error = await authError(completeLogin(TEST_CONFIG, { ...b.deps, fetch: stalls, timeoutMs: 20 }));
    expect(error.kind).toBe("token_network");
  });

  it("refuses a token answer larger than 64 KB unread", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const huge = { access_token: "eyJ".repeat(10), token_type: "Bearer", expires_in: 3600, padding: "x".repeat(70_000) };
    server.tokenOverride = { body: JSON.stringify(huge) };
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["token_exchange", "bad_token"]);
  });

  it("drops an error code from the login page that does not look like one", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await startLogin(TEST_CONFIG, b.deps);
    const state = new URL(b.navigations[0] ?? "").searchParams.get("state") ?? "";
    b.address.href = `http://localhost:5173/?error=${encodeURIComponent("<img src=x> rider@example.test")}&state=${state}`;
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["login_failed", null]);
    expect(error.message).not.toContain("rider");
  });

  it("reports a failed exchange by the OAuth code, without the code or the verifier", async () => {
    const server = createFakeServer();
    const b = browser(server);
    const back = new URL(await roundTrip(server, b));
    back.searchParams.set("code", "not-a-code-the-server-issued");
    b.address.href = back.href;
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["token_exchange", "invalid_grant"]);
    expect(error.message).not.toContain("not-a-code");
  });

  it("reports an unreachable token endpoint as a network problem", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    server.tokenOverride = "network";
    expect((await authError(completeLogin(TEST_CONFIG, b.deps))).kind).toBe("token_network");
  });

  it.each([
    ["no access token", { token_type: "Bearer", expires_in: 3600 }, "bad_token"],
    ["a token with odd characters", { access_token: "abc def<script>".repeat(3), token_type: "Bearer", expires_in: 3600 }, "bad_token"],
    ["another token type", { access_token: "eyJ".repeat(10), token_type: "mac", expires_in: 3600 }, "bad_token_type"],
    ["no expiry", { access_token: "eyJ".repeat(10), token_type: "Bearer" }, "bad_expiry"],
    ["a negative expiry", { access_token: "eyJ".repeat(10), token_type: "Bearer", expires_in: -1 }, "bad_expiry"],
    ["a zero expiry", { access_token: "eyJ".repeat(10), token_type: "Bearer", expires_in: 0 }, "bad_expiry"],
    ["an expiry in text", { access_token: "eyJ".repeat(10), token_type: "Bearer", expires_in: "3600" }, "bad_expiry"],
  ])("refuses a token answer with %s", async (_label, body, detail) => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    server.tokenOverride = { body: JSON.stringify(body) };
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["token_exchange", detail]);
  });

  it("refuses a token answer that is not JSON, naming the HTTP status only", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    server.tokenOverride = { status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" };
    const error = await authError(completeLogin(TEST_CONFIG, b.deps));
    expect([error.kind, error.detail]).toEqual(["token_exchange", "http_502"]);
  });

  it("never trusts a token life longer than a day", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    server.tokenOverride = { body: JSON.stringify({ access_token: "eyJ".repeat(10), token_type: "Bearer", expires_in: 10 ** 9 }) };
    const result = await completeLogin(TEST_CONFIG, b.deps);
    if (result.status !== "signed_in") throw new Error("expected a session");
    expect(result.session.authorization(server.clock.now + 86_400_000)).toBeNull();
  });
});

describe("a reload keeps the session (docs/PLAN.md, section 10, «El token»)", () => {
  /** Signs in, then "reloads": a fresh page whose only memory is the tab's storage. */
  async function signedInThenReloaded(): Promise<{ server: FakeServer; b: Browser; token: string; first: ReturnType<typeof resumeSession> }> {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const result = await completeLogin(TEST_CONFIG, b.deps);
    if (result.status !== "signed_in") throw new Error("expected a session");
    b.address.href = "http://localhost:5173/";
    return { server, b, token: server.issuedTokens[0] ?? "", first: result.session };
  }

  it("gives back the same token after a reload, until it expires", async () => {
    const { server, b, token } = await signedInThenReloaded();
    expect(await completeLogin(TEST_CONFIG, b.deps)).toEqual({ status: "none" });
    const again = resumeSession(TEST_CONFIG, b.deps);
    expect(again?.authorization(server.clock.now)).toBe(`Bearer ${token}`);
    // The resumed session ends with the same margin as the first one.
    expect(again?.authorization(server.clock.now + 3_600_000 - EXPIRY_MARGIN_MS)).toBeNull();
    expect(b.storage.items.size).toBe(0);
  });

  it("does not resume a token that expired while the tab was away, and removes it", async () => {
    const { server, b } = await signedInThenReloaded();
    server.clock.now += 3_600_000 - EXPIRY_MARGIN_MS;
    expect(resumeSession(TEST_CONFIG, b.deps)).toBeNull();
    expect(b.storage.items.size).toBe(0);
  });

  it("drops a damaged or tampered entry instead of using it", async () => {
    const server = createFakeServer();
    const b = browser(server);
    const now = server.clock.now;
    for (const value of [
      "not json",
      JSON.stringify({ token: "short", expiresAt: now + 3_600_000 }),
      JSON.stringify({ token: "eyJ".repeat(10), expiresAt: "later" }),
      // One character over the longest token a sign-in takes.
      JSON.stringify({ token: "a".repeat(8_193), expiresAt: now + 3_600_000 }),
      // Longer than a day: never trusted, as on the way in.
      JSON.stringify({ token: "eyJ".repeat(10), expiresAt: now + 2 * 86_400_000 }),
    ]) {
      b.storage.items.set(SAVED_KEY, value);
      expect(resumeSession(TEST_CONFIG, b.deps)).toBeNull();
      expect(b.storage.items.size).toBe(0);
    }
    expect(resumeSession(null, b.deps)).toBeNull();
  });

  it.each([
    ["expired"],
    ["unauthorized"],
    ["forbidden"],
    ["network"],
  ] as const)("forgets the stored token when the session ends by %s", async (reason) => {
    const { b, first } = await signedInThenReloaded();
    expect(b.storage.items.has(SAVED_KEY)).toBe(true);
    first?.end(reason);
    expect(b.storage.items.size).toBe(0);
  });

  it("forgets it on a resumed session too, when its clock runs out", async () => {
    const { server, b } = await signedInThenReloaded();
    const again = resumeSession(TEST_CONFIG, b.deps);
    expect(b.storage.items.has(SAVED_KEY)).toBe(true);
    server.clock.now += 3_600_000;
    expect(again?.authorization(server.clock.now)).toBeNull();
    expect(b.storage.items.size).toBe(0);
  });

  it("forgets it on sign-out, even when the page no longer holds the session", async () => {
    const { b, first } = await signedInThenReloaded();
    logout(TEST_CONFIG, first, b.deps);
    expect(b.storage.items.size).toBe(0);
    const next = await signedInThenReloaded();
    logout(TEST_CONFIG, null, next.b.deps);
    expect(next.b.storage.items.size).toBe(0);
  });

  it("forgets it when a new sign-in starts or another return arrives", async () => {
    const { b } = await signedInThenReloaded();
    await startLogin(TEST_CONFIG, b.deps);
    expect(b.storage.items.has(SAVED_KEY)).toBe(false);
    const other = await signedInThenReloaded();
    other.b.address.href = "http://localhost:5173/?code=synthetic&state=not-the-pending-one";
    await expect(completeLogin(TEST_CONFIG, other.b.deps)).rejects.toBeInstanceOf(AuthError);
    expect(other.b.storage.items.size).toBe(0);
  });

  it("keeps working in memory when the tab refuses to store the token", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const refusing = {
      getItem: (key: string) => b.storage.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === SAVED_KEY) throw new Error("quota");
        b.storage.setItem(key, value);
      },
      removeItem: (key: string) => b.storage.removeItem(key),
    };
    const result = await completeLogin(TEST_CONFIG, { ...b.deps, storage: refusing });
    if (result.status !== "signed_in") throw new Error("expected a session");
    expect(result.session.authorization(server.clock.now)).toBe(`Bearer ${server.issuedTokens[0]}`);
    expect(b.storage.items.size).toBe(0);
  });
});

describe("browser objects", () => {
  it("never hand session storage to the caller", () => {
    // `browserDeps` reads `window`; stub just enough of it for Node.
    const stub = { location: { href: "" }, history: {} };
    Object.assign(globalThis, { window: stub });
    try {
      const deps = browserDeps();
      expect("storage" in deps).toBe(false);
      expect(Object.values(deps).some((value) => typeof value === "object" && value !== null && "setItem" in value)).toBe(false);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("sign-out", () => {
  it("forgets the token and any pending login, and stays on the page without a sign-out address", async () => {
    const server = createFakeServer();
    const b = browser(server);
    await roundTrip(server, b);
    const result = await completeLogin(TEST_CONFIG, b.deps);
    if (result.status !== "signed_in") throw new Error("expected a session");
    await startLogin(TEST_CONFIG, b.deps);
    const before = b.navigations.length;
    logout(TEST_CONFIG, result.session, b.deps);
    expect(result.session.authorization(server.clock.now)).toBeNull();
    expect(result.session.endReason).toBe("signed_out");
    expect(b.storage.items.size).toBe(0);
    expect(b.navigations).toHaveLength(before);
  });

  it("ends the login session too when a sign-out address is configured", () => {
    const server = createFakeServer();
    const b = browser(server);
    logout({ ...TEST_CONFIG, logoutUri: "http://localhost:5173/" }, null, b.deps);
    const url = new URL(b.navigations[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://login.example.test/logout");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "synthetic-client-id", logout_uri: "http://localhost:5173/" });
  });

  it("still goes to the sign-out page when the storage fails to clear or to save", () => {
    const server = createFakeServer();
    const b = browser(server);
    const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    logout({ ...TEST_CONFIG, logoutUri: "http://localhost:5173/" }, null, { ...b.deps, storage: broken }, "delete_unconfirmed");
    expect(b.navigations).toHaveLength(1);
    expect(new URL(b.navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("keeps one fixed notice across the trip to the sign-out page, read once and for 10 minutes only", () => {
    const server = createFakeServer();
    const b = browser(server);
    logout({ ...TEST_CONFIG, logoutUri: "http://localhost:5173/" }, null, b.deps, "delete_unconfirmed");
    // Only the fixed word and its time.
    expect([...b.storage.items.values()].map((one) => Object.keys(JSON.parse(one) as object).sort())).toEqual([["createdAt", "notice"]]);
    expect(takeLogoutNotice(b.deps)).toBe("delete_unconfirmed");
    expect(takeLogoutNotice(b.deps)).toBeNull();
    expect(b.storage.items.size).toBe(0);
    logout(TEST_CONFIG, null, b.deps, "delete_unconfirmed");
    server.clock.now += 10 * 60 * 1000 + 1;
    expect(takeLogoutNotice(b.deps)).toBeNull();
    logout(TEST_CONFIG, null, b.deps);
    expect(takeLogoutNotice(b.deps)).toBeNull();
    b.storage.items.set("ride-log.leave-notice", JSON.stringify({ notice: "something_else", createdAt: server.clock.now }));
    expect(takeLogoutNotice(b.deps)).toBeNull();
  });
});

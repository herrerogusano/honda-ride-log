// The open service's /estado and /pase (src/access/publicAccess.ts) and the
// account tools of the /mcp client, in Node against tests/fakeServer.ts. They
// prove the contract as read from the service's code (docs/public-web.md of
// the service), not that the real endpoints, CORS or Cloudflare behave so.
import { describe, expect, it } from "vitest";
import { normalizeEmail, readStatus, requestPass } from "../src/access/publicAccess";
import { createSession } from "../src/auth/session";
import { ToolCallError } from "../src/service/contract";
import { LoadError } from "../src/service/loader";
import { errorText } from "../src/ui/errors";
import { ACCOUNT_TOOLS, ALLOWED_TOOLS, createMcpClient, ServiceError } from "../src/service/mcpClient";
import { createFakeServer, PUBLIC_CONFIG, TEST_CONFIG, type FakeServer } from "./fakeServer";

const access = PUBLIC_CONFIG.publicAccess;
if (access === null) throw new Error("the public test config has no access");

function signedInClient(server: FakeServer, publicService = true) {
  // A token the fake knows: go through its own token endpoint.
  return (async () => {
    const back = new URL(
      server.approve(
        `${PUBLIC_CONFIG.loginOrigin}/oauth2/authorize?response_type=code&client_id=${PUBLIC_CONFIG.webClientId}&redirect_uri=${encodeURIComponent(PUBLIC_CONFIG.redirectUri)}&scope=${encodeURIComponent(`openid ${PUBLIC_CONFIG.mcpUrl}/use`)}&code_challenge_method=S256&code_challenge=${"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"}&state=s`,
      ),
    );
    const response = await server.fetch(`${PUBLIC_CONFIG.loginOrigin}/oauth2/token`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: PUBLIC_CONFIG.webClientId,
        code: back.searchParams.get("code") ?? "",
        redirect_uri: PUBLIC_CONFIG.redirectUri,
        // RFC 7636 appendix B: the verifier of that challenge.
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      }),
    });
    const token = ((await response.json()) as { access_token: string }).access_token;
    const session = createSession(token, server.clock.now + 3_600_000);
    const client = createMcpClient(PUBLIC_CONFIG.mcpUrl, session, {
      fetch: server.fetch,
      now: () => server.clock.now,
      sleep: async () => undefined,
      minIntervalMs: 0,
      publicService,
    });
    return { client, session };
  })();
}

describe("GET /estado", () => {
  it.each(["abierto", "lleno", "cerrado", "pausa"])("reads %s", async (word) => {
    const server = createFakeServer(PUBLIC_CONFIG);
    server.status = word;
    expect(await readStatus(access.statusUrl, { fetch: server.fetch })).toBe(word);
  });

  it("sends a plain GET without cookies, referrer or redirects", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    await readStatus(access.statusUrl, { fetch: server.fetch });
    const sent = server.requests.at(-1);
    expect(sent?.url).toBe("https://api.example.test/estado");
    expect(sent?.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(sent?.body).toBe("");
  });

  it("reads the 503 pause the service gives when it cannot read its state", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    server.status = { status: 503, body: '{"estado": "pausa"}' };
    expect(await readStatus(access.statusUrl, { fetch: server.fetch })).toBe("pausa");
  });

  it.each([
    ["a network failure", "network" as const],
    ["an unknown word", { body: '{"estado": "abierta"}' }],
    ["not JSON", { body: "abierto", contentType: "text/plain" }],
    ["another status code", { status: 500, body: '{"estado": "abierto"}' }],
    ["a list", { body: '["abierto"]' }],
    ["a huge answer", { body: JSON.stringify({ estado: "abierto", x: "y".repeat(5000) }) }],
  ])("says unavailable for %s", async (_label, answer) => {
    const server = createFakeServer(PUBLIC_CONFIG);
    server.status = answer;
    expect(await readStatus(access.statusUrl, { fetch: server.fetch })).toBe("unavailable");
  });
});

describe("POST /pase", () => {
  it("sends exactly the normalized email and the result, as JSON, and reads the pass", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    expect(await requestPass(access.passUrl, "  Rider@Example.TEST ", "result-0001", { fetch: server.fetch })).toBe("issued");
    expect(server.passes).toEqual([{ email: "rider@example.test", turnstile: "result-0001" }]);
    const sent = server.requests.at(-1);
    expect(sent?.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(sent?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ email: "rider@example.test", turnstile: "result-0001" });
  });

  it.each([
    [400, '{"error": "peticion_invalida"}', "bad_request"],
    [403, '{"error": "control_no_valido"}', "rejected"],
    [429, '{"error": "demasiados_pases"}', "rate_limited"],
    [503, '{"error": "no_disponible"}', "unavailable"],
    [503, '{"estado": "cerrado"}', "closed"],
    [503, '{"estado": "pausa"}', "paused"],
    [404, '{"error": "no_encontrado"}', "unavailable"],
    [200, '{"pase": "otro"}', "unavailable"],
  ])("reads HTTP %i %s as %s", async (status, body, outcome) => {
    const server = createFakeServer(PUBLIC_CONFIG);
    server.passOverride = { status, body };
    expect(await requestPass(access.passUrl, "rider@example.test", "result-0001", { fetch: server.fetch })).toBe(outcome);
  });

  it("says unavailable when the request does not get through", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    server.passOverride = "network";
    expect(await requestPass(access.passUrl, "rider@example.test", "result-0001", { fetch: server.fetch })).toBe("unavailable");
  });

  it("does not send an email or a result the service would refuse", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    for (const [email, result] of [
      ["not an email", "result-0001"],
      ["rider@example", "result-0001"],
      ["a..b@example.test", "result-0001"],
      ["rider@example.test", ""],
      ["rider@example.test", "with space"],
      ["rider@example.test", "x".repeat(2049)],
    ] as const) {
      expect(await requestPass(access.passUrl, email, result, { fetch: server.fetch })).toBe("bad_request");
    }
    expect(server.requests).toHaveLength(0);
  });

  it("normalizes like the service: trimmed, lower case, its own email rule", () => {
    expect(normalizeEmail(" A.B+c@Mail.Example.ES ")).toBe("a.b+c@mail.example.es");
    expect(normalizeEmail("ñ@example.test")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(65)}@example.test`)).toBeNull();
    expect(normalizeEmail("rider@example.t")).toBeNull();
  });
});

describe("error texts of the open service", () => {
  it("say maintenance for service_paused only in a build for the open service", () => {
    const paused = new LoadError("routes", "tool_error", "service_paused");
    expect(errorText(paused, true)).toMatchObject({ explanation: "Estamos haciendo mantenimiento; vuelve más tarde.", action: "retry", code: "routes/tool_error (service_paused)" });
    expect(errorText(paused, false).explanation).toBe("El servicio ha respondido con un error.");
    expect(errorText(paused).explanation).toBe("El servicio ha respondido con un error.");
    expect(errorText(new LoadError("status", "tool_error", "session_expired"), true).action).toBe("sign_in");
    expect(errorText(new LoadError("status", "tool_error", "session_limit_reached"), true).action).toBe("sign_in");
    // A code that happens to name an object property is not a text.
    expect(errorText(new LoadError("status", "tool_error", "constructor"), true).explanation).toBe("El servicio ha respondido con un error.");
  });
});

describe("account tools of the /mcp client", () => {
  it("are not read tools: callTool refuses them, and an invitation client refuses them too", async () => {
    expect(ALLOWED_TOOLS).not.toContain("cerrar_sesion");
    expect(ACCOUNT_TOOLS).toEqual(["cerrar_sesion", "borrar_mis_datos"]);
    const server = createFakeServer(TEST_CONFIG);
    const client = createMcpClient(TEST_CONFIG.mcpUrl, createSession("eyJsynthetic.token.value", server.clock.now + 3_600_000), { fetch: server.fetch });
    for (const call of [() => client.endSession(), () => client.deleteMyData()]) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).kind).toBe("not_allowed");
    }
    // @ts-expect-error: not a read tool.
    await expect(client.callTool("cerrar_sesion", {})).rejects.toThrow(/not_allowed/);
    expect(server.requests).toHaveLength(0);
  });

  it("sends cerrar_sesion without arguments and borrar_mis_datos with confirmar=true, with the token", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    const { client } = await signedInClient(server);
    await client.endSession();
    await client.deleteMyData();
    expect(server.accountCalls).toEqual([
      { name: "cerrar_sesion", arguments: {} },
      { name: "borrar_mis_datos", arguments: { confirmar: true } },
    ]);
    const sent = server.requests.filter((one) => one.url === PUBLIC_CONFIG.mcpUrl);
    expect(sent.every((one) => /^Bearer eyJaccess\./.test(one.headers.get("authorization") ?? ""))).toBe(true);
  });

  it.each([
    ["an empty result", {}],
    ["no isError", { content: [{ type: "text", text: "Hecho." }] }],
    ["no text", { content: [], isError: false }],
    ["an empty text", { content: [{ type: "text", text: "" }], isError: false }],
    ["another item type", { content: [{ type: "resource", text: "Hecho." }], isError: false }],
  ])("does not take %s as done", async (_label, result) => {
    const server = createFakeServer(PUBLIC_CONFIG);
    const { client } = await signedInClient(server);
    server.mcpOverride = (request) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result }) });
    for (const call of [() => client.endSession(), () => client.deleteMyData()]) {
      const error = await call().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({ kind: "bad_response", detail: "account_result" });
    }
  });

  it("reports the tool's code when it fails", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    const { client } = await signedInClient(server);
    server.accountFailure = "logout_failed";
    const error = await client.endSession().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).code).toBe("logout_failed");
  });

  it("forgets the token when the open service says the session expired, and only then", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    const { client, session } = await signedInClient(server);
    server.mcpOverride = () => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "service_paused: x" }], isError: true } }) });
    await expect(client.callTool("get_vehicle_status", {})).rejects.toThrow(ToolCallError);
    expect(session.endReason).toBeNull();
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "session_expired: x" }], isError: true } }),
    });
    await expect(client.callTool("get_vehicle_status", {})).rejects.toThrow(/session_expired/);
    expect(session.endReason).toBe("expired");
    await expect(client.callTool("get_vehicle_status", {})).rejects.toThrow(/reauth_required/);
  });

  it("keeps the token after session_expired in an invitation client, as before", async () => {
    const server = createFakeServer(PUBLIC_CONFIG);
    const { client, session } = await signedInClient(server, false);
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "session_expired: x" }], isError: true } }),
    });
    await expect(client.callTool("get_vehicle_status", {})).rejects.toThrow(/session_expired/);
    expect(session.endReason).toBeNull();
  });
});

// Runs in Node against tests/fakeServer.ts, whose tools are the demo
// service. It proves the client against the `/mcp` contract as we read it in
// the service code, not that the deployed service, its authorizer or CORS
// behave this way.
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { completeLogin, startLogin, type AuthDeps } from "../src/auth/login";
import type { StorageLike } from "../src/auth/pendingLogin";
import { createSession, EXPIRY_MARGIN_MS, type AuthSession } from "../src/auth/session";
import { sanitizeRouteList, sanitizeRouteTrace, sanitizeVehicleStatus, serviceRouteId } from "../src/domain/sanitize";
import { ToolCallError, type ToolCaller, type ToolName } from "../src/service/contract";
import { ALLOWED_TOOLS, createMcpClient, ServiceError, type McpClientOptions } from "../src/service/mcpClient";
import { createFakeServer, TEST_CONFIG, type FakeServer } from "./fakeServer";

async function signIn(server: FakeServer): Promise<AuthSession> {
  const items = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
  const address = { href: "" };
  const deps: AuthDeps = {
    crypto: webcrypto as unknown as AuthDeps["crypto"],
    storage,
    fetch: server.fetch,
    currentUrl: () => address.href,
    replaceUrl: (url) => void (address.href = url),
    navigate: (url) => void (address.href = server.approve(url)),
    now: () => server.clock.now,
  };
  await startLogin(TEST_CONFIG, deps);
  const result = await completeLogin(TEST_CONFIG, deps);
  if (result.status !== "signed_in") throw new Error("expected a session");
  return result.session;
}

function clientFor(server: FakeServer, session: AuthSession, options: McpClientOptions = {}): ToolCaller {
  return createMcpClient(TEST_CONFIG.mcpUrl, session, {
    fetch: server.fetch,
    now: () => server.clock.now,
    sleep: async (ms) => {
      server.clock.now += ms;
    },
    ...options,
  });
}

async function setUp(options: McpClientOptions = {}) {
  const server = createFakeServer();
  const session = await signIn(server);
  server.requests.length = 0;
  return { server, session, client: clientFor(server, session, options) };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

const mcpRequests = (server: FakeServer) => server.requests.filter((request) => request.url.startsWith(TEST_CONFIG.mcpUrl));

describe("requests", () => {
  it("serves the four tools through the same sanitizers as the demo", async () => {
    const { client } = await setUp();
    const state = sanitizeVehicleStatus(await client.callTool("get_vehicle_status", {}));
    expect(state.batteryPercent).not.toBeNull();
    await client.callTool("get_vehicle_details", {});
    const page = sanitizeRouteList(await client.callTool("list_routes", { from_time: "2026-01-01", to_time: "2026-07-01" }));
    expect(page.routes.length).toBeGreaterThan(0);
    const first = page.routes[0];
    if (first === undefined) throw new Error("expected a route");
    const trace = sanitizeRouteTrace(await client.callTool("get_route_detail", { route_id: serviceRouteId(first.ref) }));
    expect(trace).toBeDefined();
  });

  it("sends one JSON-RPC tools/call with exactly three headers, no cookies, no query, no redirects", async () => {
    const { server, client } = await setUp();
    await client.callTool("list_routes", { from_time: "2026-01-01", to_time: "2026-02-01" });
    const [request] = mcpRequests(server);
    expect(request?.url).toBe("https://api.example.test/mcp");
    expect(request?.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect([...(request?.headers.keys() ?? [])].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${server.issuedTokens[0]}`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_routes", arguments: { from_time: "2026-01-01", to_time: "2026-02-01" } },
    });
  });

  it("returns the tool's error code as a ToolCallError, without the service's message", async () => {
    const { client } = await setUp();
    const error = await failure(client.callTool("list_routes", { from_time: "2024-01-01", to_time: "2026-01-01" }));
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).code).toBe("period_too_large");
    expect(error.message).not.toContain("input");
  });
});

describe("closed tool list and arguments", () => {
  it("allows exactly the four read tools", () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(["get_route_detail", "get_vehicle_details", "get_vehicle_status", "list_routes"]);
  });

  it.each(["borrar_mis_datos", "get_route_statistics", "tools/list", ""])("refuses %j before sending anything", async (name) => {
    const { server, client } = await setUp();
    const error = await failure(client.callTool(name as ToolName, {} as never));
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual(["not_allowed", "tool"]);
    expect(mcpRequests(server)).toEqual([]);
  });

  it.each([
    ["an extra argument", "get_vehicle_status", { confirm: "yes" }],
    ["a missing argument", "list_routes", { from_time: "2026-01-01" }],
    ["a number for a string", "get_route_detail", { route_id: 7 }],
    ["an empty route id", "get_route_detail", { route_id: "" }],
    ["a route id longer than 256 characters", "get_route_detail", { route_id: "r".repeat(257) }],
    ["no arguments object", "get_vehicle_status", null],
  ])("refuses %s before sending anything", async (_label, name, args) => {
    const { server, client } = await setUp();
    const error = await failure(client.callTool(name as ToolName, args as never));
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual(["not_allowed", "arguments"]);
    expect(mcpRequests(server)).toEqual([]);
  });
});

describe("rejected or lost token", () => {
  it("ends the session on a 401 and never sends that token again", async () => {
    const { server, session, client } = await setUp();
    server.mcpOverride = () => ({ status: 401, body: "{}" });
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual(["reauth_required", "unauthorized"]);
    expect(session.endReason).toBe("unauthorized");
    server.mcpOverride = null;
    const again = await failure(client.callTool("get_vehicle_status", {}));
    expect((again as ServiceError).kind).toBe("reauth_required");
    expect(mcpRequests(server)).toHaveLength(1);
  });

  it("treats a network failure after sign-in as 'sign in again', without retrying", async () => {
    const { server, session, client } = await setUp();
    server.mcpOverride = () => "network";
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual(["reauth_required", "network"]);
    expect(session.endReason).toBe("network");
    expect(mcpRequests(server)).toHaveLength(1);
  });

  it("ends the session on a 403 and reports it apart", async () => {
    const { server, session, client } = await setUp();
    server.mcpOverride = () => ({ status: 403, body: "{}" });
    expect(((await failure(client.callTool("get_vehicle_status", {}))) as ServiceError).kind).toBe("forbidden");
    expect(session.endReason).toBe("forbidden");
    await failure(client.callTool("get_vehicle_status", {}));
    expect(mcpRequests(server)).toHaveLength(1);
  });

  it("does not send a token that is about to expire", async () => {
    const { server, session, client } = await setUp();
    server.clock.now += 3_600_000 - EXPIRY_MARGIN_MS;
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual(["reauth_required", "expired"]);
    expect(session.endReason).toBe("expired");
    expect(mcpRequests(server)).toEqual([]);
  });

  it("does not send queued requests after the session ended", async () => {
    const { server, client } = await setUp({ maxConcurrent: 1 });
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    server.mcpOverride = () => ({ status: 401, body: "{}" });
    const calls = [1, 2, 3].map(() => client.callTool("get_vehicle_status", {}).catch((error: unknown) => error));
    release();
    const errors = await Promise.all(calls);
    expect(errors.map((error) => (error as ServiceError).kind)).toEqual(["reauth_required", "reauth_required", "reauth_required"]);
    expect(mcpRequests(server)).toHaveLength(1);
  });

  it("puts the token in no error and no request other than the Authorization header", async () => {
    const { server, client } = await setUp();
    const token = server.issuedTokens[0] ?? "";
    const errors: unknown[] = [];
    for (const answer of [{ status: 500 }, { status: 200, body: "not json" }, { status: 401 }]) {
      server.mcpOverride = () => answer;
      errors.push(await failure(client.callTool("get_vehicle_status", {})));
    }
    for (const error of errors) {
      expect(String(error) + JSON.stringify(error) + ((error as Error).stack ?? "")).not.toContain(token);
    }
    for (const request of server.requests) {
      expect(request.url + request.body).not.toContain(token);
    }
  });
});

describe("answers the client refuses", () => {
  it.each([
    ["a 429, not retried", { status: 429 }, "rate_limited", null],
    ["a 500", { status: 500 }, "http_status", "500"],
    ["an event stream", { contentType: "text/event-stream", body: "data: {}\n\n" }, "bad_response", "content_type"],
    ["text that is not JSON", { body: "<html>" }, "bad_response", "json"],
    ["another JSON-RPC id", { body: JSON.stringify({ jsonrpc: "2.0", id: 99, result: { structuredContent: {} } }) }, "bad_response", "envelope"],
    ["no jsonrpc marker", { body: JSON.stringify({ id: 1, result: { structuredContent: {} } }) }, "bad_response", "envelope"],
    ["a JSON-RPC error", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } }) }, "rpc_error", "-32602"],
    ["no structured content", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }) }, "bad_response", "structured_content"],
    ["an array as content", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: [] } }) }, "bad_response", "structured_content"],
    ["an array as result", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ structuredContent: {} }] }) }, "bad_response", "result"],
    ["a JSON-RPC error with a text code", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "rider@example.test" } }) }, "rpc_error", null],
    ["a 204", { status: 204, body: "" }, "http_status", "204"],
    ["a 201", { status: 201, body: "{}" }, "http_status", "201"],
    ["a JSON sequence", { contentType: "application/json-seq", body: "{}" }, "bad_response", "content_type"],
    ["an answer over 4 MiB", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { x: "y".repeat(4_200_000) } } }) }, "bad_response", "too_large"],
  ])("refuses %s", async (_label, answer, kind, detail) => {
    const { server, session, client } = await setUp();
    server.mcpOverride = () => answer;
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect(error).toBeInstanceOf(ServiceError);
    expect([(error as ServiceError).kind, (error as ServiceError).detail]).toEqual([kind, detail]);
    expect(mcpRequests(server)).toHaveLength(1);
    // These do not end the session: the next call goes out.
    expect(session.endReason).toBeNull();
  });

  it("reports a tool error whose text is not a code as a generic tool error", async () => {
    const { server, client } = await setUp();
    const result = { isError: true, content: [{ type: "text", text: "Route ABC123 not found for rider@example.test" }] };
    server.mcpOverride = () => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect((error as ToolCallError).code).toBe("tool_error");
    expect(error.message).not.toContain("ABC123");
  });

  it.each([
    ["an identifier before the colon", "r7f3a9c2e1: unknown route"],
    ["a single word", "abc: unknown route"],
    ["no colon at all", "Something went wrong"],
  ])("does not take %s for an error code", async (_label, text) => {
    const { server, client } = await setUp();
    server.mcpOverride = () => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text }] } }) });
    expect(((await failure(client.callTool("get_vehicle_status", {}))) as ToolCallError).code).toBe("tool_error");
  });

  it("treats isError as an error even when structured content comes with it", async () => {
    const { server, client } = await setUp();
    const result = { isError: true, structuredContent: { battery: 50 }, content: [{ type: "text", text: "invalid_route_id: x" }] };
    server.mcpOverride = () => ({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect(error).toBeInstanceOf(ToolCallError);
    expect((error as ToolCallError).code).toBe("invalid_route_id");
  });

  it("gives up on an answer whose body never ends, and keeps the session", async () => {
    const { session } = await setUp();
    const stalls: typeof fetch = async (_input, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = createMcpClient(TEST_CONFIG.mcpUrl, session, { fetch: stalls, timeoutMs: 20, now: () => Date.parse("2026-07-01T10:00:00Z") });
    const error = await failure(client.callTool("get_vehicle_status", {}));
    expect((error as ServiceError).kind).toBe("timeout");
    expect(session.endReason).toBeNull();
  });

  it("gives up on an answer that takes too long", async () => {
    // A server that never answers; like a browser, the fetch rejects with the signal's reason.
    const neverAnswers: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const { server, session } = await setUp();
    const error = await failure(createMcpClient(TEST_CONFIG.mcpUrl, session, { fetch: neverAnswers, timeoutMs: 20, now: () => server.clock.now }).callTool("get_vehicle_status", {}));
    expect((error as ServiceError).kind).toBe("timeout");
    // A slow answer is not a lost token.
    expect(session.endReason).toBeNull();
  });
});

describe("pace", () => {
  it("keeps at most two requests in flight and spaces their starts", async () => {
    // Fake timers: each sleep wakes at its own instant on the fake clock, one
    // at a time and in order, so the gap measured is the client's, not the
    // machine's load.
    const server = createFakeServer();
    const session = await signIn(server);
    const timers: { at: number; wake: () => void }[] = [];
    let pumping = false;
    async function pump() {
      if (pumping) return;
      pumping = true;
      while (timers.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (next === undefined) break;
        server.clock.now = Math.max(server.clock.now, next.at);
        next.wake();
      }
      pumping = false;
    }
    const sleep = (ms: number) =>
      new Promise<void>((wake) => {
        timers.push({ at: server.clock.now + ms, wake });
        void pump();
      });
    const client = createMcpClient(TEST_CONFIG.mcpUrl, session, { fetch: server.fetch, minIntervalMs: 250, now: () => server.clock.now, sleep });
    server.requests.length = 0;
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const calls = Array.from({ length: 6 }, () => client.callTool("get_vehicle_status", {}));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mcpRequests(server)).toHaveLength(2);
    release();
    await Promise.all(calls);
    expect(server.peakConcurrency()).toBe(2);
    const starts = mcpRequests(server).map((request) => request.startedAt);
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(250);
  });

  it("frees the slot when waiting fails, so later calls still run", async () => {
    const { server, session } = await setUp();
    let failNext = true;
    const sleep = async () => {
      if (failNext) {
        failNext = false;
        throw new Error("timer failed");
      }
    };
    const client = clientFor(server, session, { maxConcurrent: 1, minIntervalMs: 250, sleep });
    await client.callTool("get_vehicle_status", {});
    await expect(client.callTool("get_vehicle_status", {})).rejects.toThrow("timer failed");
    const third = await Promise.race([
      client.callTool("get_vehicle_status", {}).then(() => "ran"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 200)),
    ]);
    expect(third).toBe("ran");
  });

  it("can run strictly one at a time", async () => {
    const { server, client } = await setUp({ maxConcurrent: 1 });
    await Promise.all(Array.from({ length: 4 }, () => client.callTool("get_vehicle_status", {})));
    expect(server.peakConcurrency()).toBe(1);
  });
});

describe("session", () => {
  it("is usable until the margin before expiry and then ends by itself", () => {
    const session = createSession("eyJ".repeat(10), 1_000_000);
    expect(session.authorization(1_000_000 - EXPIRY_MARGIN_MS - 1)).toBe(`Bearer ${"eyJ".repeat(10)}`);
    expect(session.authorization(1_000_000 - EXPIRY_MARGIN_MS)).toBeNull();
    expect(session.endReason).toBe("expired");
  });

  it("keeps the first reason it ended for", () => {
    const session = createSession("eyJ".repeat(10), 1_000_000);
    session.end("unauthorized");
    session.end("signed_out");
    expect(session.endReason).toBe("unauthorized");
  });

  it("does not expose the token as a property", () => {
    const session = createSession("eyJsecretvalue", 1_000_000);
    expect(JSON.stringify(session)).not.toContain("secretvalue");
    expect(Object.values(session).map(String).join()).not.toContain("secretvalue");
    expect(Object.isFrozen(session)).toBe(true);
  });
});

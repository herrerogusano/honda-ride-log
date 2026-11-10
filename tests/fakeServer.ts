/**
 * A fake of the two servers the browser talks to, behind a `fetch` function:
 * the managed login (authorize and token endpoints) and `POST /mcp`. Tools
 * are answered by the demo service wrapped in JSON-RPC.
 *
 * It enforces the contract as we read it (docs/PLAN.md, sections 5 and 10):
 * PKCE S256, single-use codes, exact redirect_uri, only the allowed headers,
 * no cookies, no query string, plain JSON answers. Passing against it proves
 * that contract, not that the real login, CORS or `/mcp` behave this way.
 */
import { createHash } from "node:crypto";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { ToolCallError, type ToolCaller, type ToolName } from "../src/service/contract";
import type { ServiceConfig } from "../src/service/environment";

/** Synthetic values only: no real deployment. */
export const TEST_CONFIG: ServiceConfig = Object.freeze({
  mcpUrl: "https://api.example.test/mcp",
  loginOrigin: "https://login.example.test",
  webClientId: "synthetic-client-id",
  redirectUri: "http://localhost:5173/",
  logoutUri: null,
  sendResourceIndicator: true,
});

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
  readonly body: string;
  readonly startedAt: number;
}

export interface McpAnswer {
  status?: number;
  contentType?: string;
  body?: string;
}

export interface FakeServer {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
  /** Simulates the user signing in at the login page; returns the address the login sends the browser back to. */
  approve(authorizeUrl: string): string;
  /** Answers every token request with this, if set. */
  tokenOverride: McpAnswer | "network" | null;
  /** Answers `/mcp` with this instead of the tool, if set. "network" rejects like a CORS-less error. */
  mcpOverride: ((request: RecordedRequest) => McpAnswer | "network" | null) | null;
  /** Access tokens issued so far. */
  readonly issuedTokens: string[];
  /** Refresh and ID tokens issued so far: they must never be kept by the client. */
  readonly otherTokens: string[];
  /** Highest number of `/mcp` requests in flight at once. */
  readonly peakConcurrency: () => number;
  /** Lets in-flight `/mcp` answers wait for this before resolving. */
  hold: Promise<void> | null;
  tools: ToolCaller;
  clock: { now: number };
}

const ALLOWED_MCP_HEADERS = new Set(["authorization", "content-type", "accept"]);
const sha256Url = (text: string) => createHash("sha256").update(text).digest("base64url");

export function createFakeServer(config: ServiceConfig = TEST_CONFIG): FakeServer {
  const tools: ToolCaller = createDemoService(generateRider({ seed: 7, nowMs: Date.parse("2026-07-01T00:00:00Z") }));
  const codes = new Map<string, { challenge: string; redirectUri: string; used: boolean }>();
  const tokens = new Map<string, number>();
  const issuedTokens: string[] = [];
  const otherTokens: string[] = [];
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}${(++counter).toString().padStart(4, "0")}SyntheticTokenValue`;

  const json = (status: number, value: unknown, contentType = "application/json") =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": contentType } });

  const server: FakeServer = {
    requests,
    issuedTokens,
    otherTokens,
    tokenOverride: null,
    mcpOverride: null,
    hold: null,
    tools,
    clock: { now: Date.parse("2026-07-01T10:00:00Z") },
    peakConcurrency: () => peak,

    approve(authorizeUrl) {
      const url = new URL(authorizeUrl);
      const p = url.searchParams;
      if (url.origin + url.pathname !== `${config.loginOrigin}/oauth2/authorize`) throw new Error("wrong authorize endpoint");
      if (p.get("response_type") !== "code") throw new Error("response_type");
      if (p.get("client_id") !== config.webClientId) throw new Error("client_id");
      if (p.get("redirect_uri") !== config.redirectUri) throw new Error("redirect_uri");
      if (p.get("scope") !== `openid ${config.mcpUrl}/use`) throw new Error("scope");
      if (p.get("code_challenge_method") !== "S256") throw new Error("code_challenge_method");
      const challenge = p.get("code_challenge") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error("code_challenge");
      const state = p.get("state");
      if (state === null) throw new Error("state");
      const code = unique("code");
      codes.set(code, { challenge, redirectUri: config.redirectUri, used: false });
      const back = new URL(config.redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      return back.href;
    },

    fetch: async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
      const request: RecordedRequest = { url, init, headers, body, startedAt: server.clock.now };
      requests.push(request);

      if (url === `${config.loginOrigin}/oauth2/token`) {
        if (server.tokenOverride === "network") throw new TypeError("Failed to fetch");
        if (server.tokenOverride !== null) {
          return new Response(server.tokenOverride.body ?? "", {
            status: server.tokenOverride.status ?? 200,
            headers: { "content-type": server.tokenOverride.contentType ?? "application/json" },
          });
        }
        if (init.method !== "POST" || init.credentials !== "omit") return json(400, { error: "invalid_request" });
        if (headers.get("content-type") !== "application/x-www-form-urlencoded") return json(400, { error: "invalid_request" });
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get("code") ?? "");
        if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== config.webClientId) {
          return json(400, { error: "invalid_client" });
        }
        if (grant === undefined || grant.used) return json(400, { error: "invalid_grant" });
        grant.used = true;
        if (form.get("redirect_uri") !== grant.redirectUri) return json(400, { error: "invalid_grant" });
        if (sha256Url(form.get("code_verifier") ?? "") !== grant.challenge) return json(400, { error: "invalid_grant" });
        const access = unique("eyJaccess.");
        const refresh = unique("eyJrefresh.");
        const id = unique("eyJid.");
        issuedTokens.push(access);
        otherTokens.push(refresh, id);
        tokens.set(access, server.clock.now + 3_600_000);
        return json(200, { access_token: access, id_token: id, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
      }

      if (url.startsWith(config.mcpUrl)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          if (server.hold !== null) await server.hold;
          const override = server.mcpOverride?.(request) ?? null;
          if (override === "network") throw new TypeError("Failed to fetch");
          if (override !== null) {
            return new Response(override.status === 204 ? null : (override.body ?? ""), {
              status: override.status ?? 200,
              headers: { "content-type": override.contentType ?? "application/json" },
            });
          }
          return await answerMcp(request);
        } finally {
          inFlight -= 1;
        }
      }
      throw new TypeError("Failed to fetch");
    },
  };

  async function answerMcp(request: RecordedRequest): Promise<Response> {
    const { url, init, headers } = request;
    // The service rejects a query string, cookies and unexpected methods.
    if (url !== config.mcpUrl || init.method !== "POST" || init.credentials !== "omit" || headers.has("cookie")) {
      return json(400, { error: "bad_request" });
    }
    for (const name of headers.keys()) if (!ALLOWED_MCP_HEADERS.has(name)) return json(400, { error: "header_not_allowed" });
    if (!/^application\/json/.test(headers.get("content-type") ?? "")) return json(415, {});
    if (!(headers.get("accept") ?? "").includes("application/json")) return json(406, {});
    const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1];
    const expiry = token === undefined ? undefined : tokens.get(token);
    if (expiry === undefined || server.clock.now >= expiry) return json(401, { message: "Unauthorized" });

    const message = JSON.parse(request.body) as { jsonrpc: string; id: number; method: string; params: { name: ToolName; arguments: never } };
    if (message.jsonrpc !== "2.0" || message.method !== "tools/call") {
      return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
    try {
      const result = await tools.callTool(message.params.name, message.params.arguments);
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false },
      });
    } catch (error) {
      const code = error instanceof ToolCallError ? error.code : "tool_error";
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `${code}: something about the input` }], isError: true },
      });
    }
  }

  return server;
}

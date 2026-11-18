/**
 * The real `ToolCaller`: one JSON-RPC `tools/call` per `POST /mcp`, without
 * an MCP session and without `initialize` (docs/PLAN.md, sections 5 and 10).
 *
 * What it sends, and nothing more: `Authorization: Bearer <token>`,
 * `Content-Type: application/json` and `Accept: application/json,
 * text/event-stream`; no cookies (`credentials: "omit"`), no query string,
 * no redirects, no `MCP-Protocol-Version` (optional, and a value the service
 * does not know would be rejected). Answers are plain JSON; an event stream
 * or a session id is not expected and is not followed.
 *
 * Limits: only the four read tools of `ALLOWED_TOOLS` through `callTool`
 * (the open service's two account tools go only through `endSession` and
 * `deleteMyData`, and only with `publicService`); at most two requests
 * in flight and a gap between starts, to stay well under the account-wide
 * 10 requests per second and 10 concurrent executions; no automatic retries.
 * After a 401, a 403 or a network failure the session ends, so a token the
 * service no longer accepts is never sent again: the user signs in again.
 *
 * Errors are `ServiceError`s (transport) or `ToolCallError`s (the tool
 * answered with an error). Their messages carry closed codes only: never the
 * token, the address, a body or a message from the service.
 */
import type { AuthSession, EndReason } from "../auth/session";
import { ToolCallError, type ToolArguments, type ToolCaller, type ToolName } from "./contract";

/** Closed list. `get_route_detail` is the last one; never a tool that writes or deletes. */
export const ALLOWED_TOOLS: readonly ToolName[] = Object.freeze([
  "get_vehicle_status",
  "get_vehicle_details",
  "list_routes",
  "get_route_detail",
]);

/**
 * The two account tools of the open service (docs/PLAN.md, section 18):
 * `cerrar_sesion` deletes the session on the service at once, and
 * `borrar_mis_datos` (with `confirmar: true`) also deletes the record of the
 * person's sign-ins. They are not in `ALLOWED_TOOLS` and `callTool` refuses
 * them: only `endSession` and `deleteMyData` send them, and only in a client
 * made with `publicService: true`.
 */
export const ACCOUNT_TOOLS = Object.freeze(["cerrar_sesion", "borrar_mis_datos"] as const);
export type AccountTool = (typeof ACCOUNT_TOOLS)[number];

/** The real client: the read tools, plus the account tools of the open service. */
export interface McpClient extends ToolCaller {
  /** `cerrar_sesion`. Resolves when the service says the session is gone; else throws. */
  endSession(): Promise<void>;
  /** `borrar_mis_datos` with `confirmar: true`. Resolves when the service says the data is gone; else throws. */
  deleteMyData(): Promise<void>;
}

export type ServiceErrorKind =
  /** Sign in again: the token expired, was rejected (401) or the request failed after sign-in. */
  | "reauth_required"
  /** 403: the account or token lacks access. The session is ended too, to avoid a loop. */
  | "forbidden"
  /** 429: too many requests. Not retried. */
  | "rate_limited"
  /** Any other HTTP status; `detail` is the number. */
  | "http_status"
  /** No answer within the client's deadline. */
  | "timeout"
  /** Not JSON, not JSON-RPC, wrong id or no `structuredContent`. */
  | "bad_response"
  /** A JSON-RPC error object; `detail` is its numeric code. */
  | "rpc_error"
  /** A tool outside `ALLOWED_TOOLS` or malformed arguments: refused before sending. */
  | "not_allowed";

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;
  /** Safe to show: a closed reason, a status or a numeric code. Never a value from the answer. */
  readonly detail: string | null;
  constructor(kind: ServiceErrorKind, detail: string | null = null) {
    super(`service request failed: ${kind}${detail === null ? "" : ` (${detail})`}`);
    this.name = "ServiceError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface McpClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Client deadline per request. The service has 14 s inside. */
  readonly timeoutMs?: number;
  /** 1 or 2. */
  readonly maxConcurrent?: 1 | 2;
  /** Minimum gap between the start of two requests. */
  readonly minIntervalMs?: number;
  /**
   * The open service (docs/PLAN.md, section 18): allows the two account
   * tools. A tool answer `session_expired` ends the session in both modes
   * (the service has already deleted it), so that token is not sent again.
   */
  readonly publicService?: boolean;
}

const DEFAULTS = { timeoutMs: 20_000, maxConcurrent: 2, minIntervalMs: 250 } as const;
/** The service caps answers at 2 MiB; a longer text is refused unread. */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
/**
 * What a tool error code looks like: two to six lowercase words joined by
 * `_` (`period_too_large`, `invalid_route_id`). No digits and no single
 * word, so an identifier at the start of a message is not taken for a code
 * and shown on screen.
 */
const SAFE_TOOL_CODE = /^[a-z]+(?:_[a-z]+){1,5}$/;

/**
 * Every code the service's tool errors can start with, for the tools this web
 * calls (read from the `honda-mapit-mcp` service code: its `ServiceError`
 * codes of the read path, the open service's refusals and account failures,
 * and the invitation service's tenant refusals). Any other code, even one
 * with a valid form, is shown as `tool_error`: a word the service never
 * sends is not read as one.
 */
export const SERVICE_TOOL_CODES: readonly string[] = [
  // Read path (`services.py`).
  "authentication_failed",
  "credential_store_failed",
  "distance_unavailable",
  "duplicate_route_conflict",
  "internal_error",
  "invalid_date_range",
  "invalid_response",
  "invalid_route_id",
  "invalid_route_timestamp",
  "mapit_request_failed",
  "mapit_unavailable",
  "not_found",
  "numeric_overflow",
  "pagination_unsupported",
  "period_too_large",
  "rate_limited",
  "response_too_large",
  "route_limit_exceeded",
  "route_outside_requested_interval",
  "vehicle_not_found",
  // Open service (`public_web_service.py`).
  "session_expired",
  "session_limit_reached",
  "service_paused",
  "service_unavailable",
  "logout_failed",
  "delete_failed",
  // Invitation service (`invited_mcp.py`).
  "tenant_unauthorized",
  "tenant_provider_failed",
];

/** The rejection of `AbortSignal.timeout` (a DOMException named `TimeoutError`, whatever realm made it). */
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

function reauth(session: AuthSession, why: EndReason): ServiceError {
  session.end(why);
  return new ServiceError("reauth_required", why);
}

/** Copies only the arguments each tool takes, as strings; anything else is refused. */
function requestArguments(name: ToolName, args: unknown): Record<string, string> {
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
  if (given === null) throw new ServiceError("not_allowed", "arguments");
  const keys: Record<ToolName, readonly string[]> = {
    get_vehicle_status: [],
    get_vehicle_details: [],
    list_routes: ["from_time", "to_time"],
    get_route_detail: ["route_id"],
  };
  const expected = keys[name];
  if (Object.keys(given).some((key) => !expected.includes(key))) throw new ServiceError("not_allowed", "arguments");
  const copy: Record<string, string> = {};
  for (const key of expected) {
    const value = given[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new ServiceError("not_allowed", "arguments");
    copy[key] = value;
  }
  return copy;
}

/**
 * The code at the start of a tool error's text. The MCP Python SDK puts
 * "Error executing tool <name>: " before the service's own text; that exact
 * prefix is taken off, and only for the tool that was called, before the
 * code is read. Anything else that is not a code is a generic `tool_error`.
 */
function toolCode(result: Record<string, unknown>, tool: string): string {
  const content = result["content"];
  const first = Array.isArray(content) ? (content[0] as unknown) : undefined;
  const raw = typeof first === "object" && first !== null ? (first as Record<string, unknown>)["text"] : undefined;
  if (typeof raw !== "string") return "tool_error";
  const prefix = `Error executing tool ${tool}: `;
  const text = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const code = text.split(":", 1)[0]?.trim() ?? "";
  return SAFE_TOOL_CODE.test(code) && SERVICE_TOOL_CODES.includes(code) ? code : "tool_error";
}

/**
 * Reads a JSON-RPC answer to request `id`; returns the tool's object. The
 * account tools answer with a text, which is not read (`requireStructured`
 * false): for them the answer must say `isError: false` and carry a
 * non-empty text item, or it is `bad_response`.
 */
function readEnvelope(payload: unknown, id: number, tool: string, requireStructured = true): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ServiceError("bad_response", "envelope");
  const envelope = payload as Record<string, unknown>;
  if (envelope["jsonrpc"] !== "2.0" || envelope["id"] !== id) throw new ServiceError("bad_response", "envelope");
  if ("error" in envelope) {
    const error = envelope["error"];
    const code = typeof error === "object" && error !== null ? (error as Record<string, unknown>)["code"] : undefined;
    throw new ServiceError("rpc_error", Number.isInteger(code) ? String(code) : null);
  }
  const result = envelope["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new ServiceError("bad_response", "result");
  const fields = result as Record<string, unknown>;
  // The code is shown; the service's message is not (it may quote input).
  if (fields["isError"] === true) throw new ToolCallError(toolCode(fields, tool), "the service reported an error");
  if (!requireStructured) {
    // The text is not read, but it must be there: `result: {}` is not a "done".
    const content = fields["content"];
    const first = Array.isArray(content) ? (content[0] as unknown) : undefined;
    const item = typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
    if (fields["isError"] !== false || item === null || item["type"] !== "text" || typeof item["text"] !== "string" || item["text"] === "") {
      throw new ServiceError("bad_response", "account_result");
    }
    return null;
  }
  const structured = fields["structuredContent"];
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) {
    throw new ServiceError("bad_response", "structured_content");
  }
  return structured;
}

export function createMcpClient(mcpUrl: string, session: AuthSession, options: McpClientOptions = {}): McpClient {
  const publicService = options.publicService === true;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
  const minIntervalMs = options.minIntervalMs ?? DEFAULTS.minIntervalMs;

  let nextId = 1;
  let active = 0;
  let nextStartMs = -Infinity;
  const waiting: (() => void)[] = [];
  /** Set when an account tool starts (signing out or deleting): no read starts after it. */
  let closing = false;

  /** Waits for a free slot and takes it. Never throws, so `release` always balances it. */
  async function acquire(): Promise<void> {
    while (active >= maxConcurrent) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  }

  /** Waits until the gap since the previous start has passed. */
  async function pace(): Promise<void> {
    const startAt = Math.max(now(), nextStartMs);
    nextStartMs = startAt + minIntervalMs;
    const wait = startAt - now();
    if (wait > 0) await sleep(wait);
  }

  function release(): void {
    active -= 1;
    waiting.shift()?.();
  }

  async function send(name: ToolName | AccountTool, args: Record<string, string | boolean>): Promise<unknown> {
    // Checked when the request actually starts: a queued call never uses a
    // token that ended while it waited, nor one that is being signed out.
    if (closing && !(ACCOUNT_TOOLS as readonly string[]).includes(name)) throw new ServiceError("reauth_required", "signed_out");
    const authorization = session.authorization(now());
    if (authorization === null) throw new ServiceError("reauth_required", session.endReason ?? "expired");
    const id = nextId++;
    let response: Response;
    try {
      response = await doFetch(mcpUrl, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) throw new ServiceError("timeout");
      // A 401 without CORS headers reaches the page as a network error, so
      // after a valid sign-in this is treated as "sign in again", not retried.
      throw reauth(session, "network");
    }

    if (response.status === 401) throw reauth(session, "unauthorized");
    if (response.status === 403) {
      session.end("forbidden");
      throw new ServiceError("forbidden");
    }
    if (response.status === 429) throw new ServiceError("rate_limited");
    if (response.status !== 200) throw new ServiceError("http_status", String(response.status));
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(type)) throw new ServiceError("bad_response", "content_type");

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isTimeout(error)) throw new ServiceError("timeout");
      // The connection dropped while the answer came in: the same as a failed fetch.
      throw reauth(session, "network");
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new ServiceError("bad_response", "too_large");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ServiceError("bad_response", "json");
    }
    try {
      return readEnvelope(payload, id, name, !(ACCOUNT_TOOLS as readonly string[]).includes(name));
    } catch (error) {
      // The service deleted the session already: never send this token again,
      // and the copy kept in the tab goes with it (in both modes).
      if (error instanceof ToolCallError && error.code === "session_expired") session.end("expired");
      throw error;
    }
  }

  async function queued<T>(run: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      await pace();
      return await run();
    } finally {
      release();
    }
  }

  async function accountTool(name: AccountTool, args: Record<string, boolean>): Promise<void> {
    if (!publicService) throw new ServiceError("not_allowed", "tool");
    // Leaving: reads still waiting in the queue never go out with the token.
    closing = true;
    await queued(() => send(name, args));
  }

  return {
    endSession: () => accountTool("cerrar_sesion", {}),
    deleteMyData: () => accountTool("borrar_mis_datos", { confirmar: true }),
    async callTool<N extends ToolName>(name: N, args: ToolArguments[N]): Promise<unknown> {
      // Checked at run time too: the type system does not survive a cast.
      if (!ALLOWED_TOOLS.includes(name)) throw new ServiceError("not_allowed", "tool");
      const copy = requestArguments(name, args);
      return queued(() => send(name, copy));
    },
  };
}

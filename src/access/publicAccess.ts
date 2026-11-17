/**
 * The two public endpoints of the open service (docs/PLAN.md, section 18),
 * read from the service's contract (`docs/public-web.md` of the service):
 *
 * - `GET /estado` answers `{"estado": "abierto" | "lleno" | "cerrado" |
 *   "pausa"}` (200, or 503 with `pausa` when it cannot read its state).
 * - `POST /pase` takes exactly `{"email": ..., "turnstile": ...}` and answers
 *   `{"pase": "emitido", ...}` or a fixed error word.
 *
 * Neither needs a token, and neither answer says anything about a person:
 * the pass answer is the same for every email. Requests go out without
 * cookies, without a referrer, without following redirects and with a
 * deadline. The email leaves the browser only in the pass request body and
 * as the `login_hint` of the login page (src/auth/login.ts).
 */

/** What `/estado` says, plus `unavailable` when it could not be read at all. */
export type AccessStatus = "abierto" | "lleno" | "cerrado" | "pausa" | "unavailable";

/** The outcome of `POST /pase`, in closed terms. */
export type PassOutcome =
  /** Pass written: the login may start now (it lasts 5 minutes and 3 attempts). */
  | "issued"
  /** 400: the body or the email was refused. */
  | "bad_request"
  /** 403: the check was rejected or its result was already used. */
  | "rejected"
  /** 429: too many passes from this connection in 10 minutes. */
  | "rate_limited"
  /** 503 with `{"estado": "cerrado"}`. */
  | "closed"
  /** 503 with `{"estado": "pausa"}`. */
  | "paused"
  /** 503 `no_disponible`, any other answer, a network failure or the deadline. */
  | "unavailable";

export interface AccessDeps {
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

const TIMEOUT_MS = 10_000;
const MAX_ANSWER_CHARS = 4 * 1024;
/** Turnstile results are at most 2048 printable ASCII characters (service contract). */
const RESULT_PATTERN = /^[\x21-\x7e]{1,2048}$/;
/** The service's own email rule, after trimming and lower-casing (`normalize_email`). */
const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/;

const STATUSES: readonly AccessStatus[] = ["abierto", "lleno", "cerrado", "pausa"];

/**
 * The email as the service will read it: trimmed and lower-cased. `null` if
 * the service would refuse it, so the page can say so before asking anything.
 */
export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || email.includes("..") || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

const requestInit = (deps: AccessDeps): RequestInit => ({
  credentials: "omit",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
  signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
});

/** Reads a small JSON object, or null for anything else. Never throws. */
async function smallJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return null;
  try {
    const text = await response.text();
    if (text.length > MAX_ANSWER_CHARS) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `GET /estado`. Anything but one of the four words is `unavailable`. */
export async function readStatus(statusUrl: string, deps: AccessDeps): Promise<AccessStatus> {
  let response: Response;
  try {
    response = await deps.fetch(statusUrl, { ...requestInit(deps), method: "GET", headers: { Accept: "application/json" } });
  } catch {
    return "unavailable";
  }
  if (response.status !== 200 && response.status !== 503) return "unavailable";
  const body = await smallJson(response);
  const value = body?.["estado"];
  return STATUSES.find((one) => one === value) ?? "unavailable";
}

/**
 * `POST /pase` with the normalized email and the Turnstile result. A value
 * the service would refuse is not sent (`bad_request`).
 */
export async function requestPass(passUrl: string, email: string, turnstile: string, deps: AccessDeps): Promise<PassOutcome> {
  const normalized = normalizeEmail(email);
  if (normalized === null || !RESULT_PATTERN.test(turnstile)) return "bad_request";
  let response: Response;
  try {
    response = await deps.fetch(passUrl, {
      ...requestInit(deps),
      method: "POST",
      // The service accepts exactly this media type, with or without charset=utf-8.
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: normalized, turnstile }),
    });
  } catch {
    return "unavailable";
  }
  const body = await smallJson(response);
  if (response.status === 200) return body?.["pase"] === "emitido" ? "issued" : "unavailable";
  if (response.status === 400) return "bad_request";
  if (response.status === 403) return "rejected";
  if (response.status === 429) return "rate_limited";
  if (response.status === 503 && body?.["estado"] === "cerrado") return "closed";
  if (response.status === 503 && body?.["estado"] === "pausa") return "paused";
  return "unavailable";
}

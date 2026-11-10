/**
 * Sign-in against the managed login (Amazon Cognito) with the authorization
 * code flow and PKCE, as a public client without a secret
 * (docs/PLAN.md, section 10).
 *
 * 1. `startLogin` creates a verifier and a `state`, keeps them in
 *    `sessionStorage` (the only use of browser storage) and sends the browser
 *    to `/oauth2/authorize`.
 * 2. Back on the page, `completeLogin` reads `code` and `state` from the
 *    address, removes them from it at once, checks the `state`, and trades
 *    the code for tokens at `/oauth2/token`.
 * 3. Only the access token is kept, in memory (`AuthSession`). The ID token
 *    and the refresh token that the login also returns are dropped.
 *
 * Errors are `AuthError`s with a closed `kind` and a `detail` that is either
 * null or a short OAuth error code: never a token, a code, a URL or a body.
 */
import type { ServiceConfig } from "../service/environment";
import {
  browserSessionStorage,
  clearPendingLogin,
  savePendingLogin,
  takePendingLogin,
  type PendingLogin,
  type StorageLike,
} from "./pendingLogin";
import { challengeFor, randomToken, type CryptoLike } from "./pkce";
import { createSession, type AuthSession } from "./session";

export type AuthErrorKind =
  /** The build has no service configured: only the demo exists. */
  | "config_missing"
  /** `sessionStorage` is unavailable, so the round trip cannot be checked. */
  | "storage_unavailable"
  /** Back from the login with no pending login, an expired one or another `state`. */
  | "state_mismatch"
  /** The login page answered with `error=...` (for example `access_denied`). */
  | "login_failed"
  /** The token endpoint answered with an error or something unexpected. */
  | "token_exchange"
  /** The token endpoint could not be reached (network, CORS or timeout). */
  | "token_network";

export class AuthError extends Error {
  readonly kind: AuthErrorKind;
  readonly detail: string | null;
  constructor(kind: AuthErrorKind, detail: string | null = null) {
    super(`sign-in failed: ${kind}${detail === null ? "" : ` (${detail})`}`);
    this.name = "AuthError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** Browser objects the flow uses; `browserDeps()` gives the real ones. */
export interface AuthDeps {
  readonly crypto: CryptoLike;
  readonly storage: StorageLike | null;
  readonly fetch: typeof fetch;
  /** Current address of the page. */
  readonly currentUrl: () => string;
  /** Replaces the address without reloading (`history.replaceState`). */
  readonly replaceUrl: (url: string) => void;
  /** Leaves the page for another address (`location.assign`). */
  readonly navigate: (url: string) => void;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

export function browserDeps(): AuthDeps {
  return {
    crypto: globalThis.crypto,
    storage: browserSessionStorage(),
    fetch: globalThis.fetch.bind(globalThis),
    currentUrl: () => window.location.href,
    replaceUrl: (url) => window.history.replaceState(null, "", url),
    navigate: (url) => window.location.assign(url),
    now: () => Date.now(),
  };
}

const TOKEN_TIMEOUT_MS = 20_000;
/** OAuth error codes are short lowercase words; anything else is not shown. */
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** JWT characters; a Cognito access token is about 1 KB. */
const TOKEN_PATTERN = /^[A-Za-z0-9\-_.]{20,8192}$/;
const MAX_TOKEN_RESPONSE_CHARS = 64 * 1024;

const safeCode = (value: unknown): string | null => (typeof value === "string" && SAFE_CODE.test(value) ? value : null);

/** The scopes the service requires: `openid` and `<mcpUrl>/use`. */
export function scopesFor(config: ServiceConfig): string {
  return `openid ${config.mcpUrl}/use`;
}

export function authorizeUrl(config: ServiceConfig, state: string, challenge: string): string {
  const url = new URL("/oauth2/authorize", config.loginOrigin);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", config.webClientId);
  params.set("redirect_uri", config.redirectUri);
  params.set("scope", scopesFor(config));
  params.set("state", state);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  // Unverified: believed to set the audience of the token (RFC 8707).
  if (config.sendResourceIndicator) params.set("resource", config.mcpUrl);
  return url.href;
}

/** Sends the browser to the login page. Resolves only if navigation is stubbed. */
export async function startLogin(config: ServiceConfig | null, deps: AuthDeps): Promise<void> {
  if (config === null) throw new AuthError("config_missing");
  if (deps.storage === null) throw new AuthError("storage_unavailable");
  const verifier = randomToken(deps.crypto);
  const state = randomToken(deps.crypto);
  const challenge = await challengeFor(verifier, deps.crypto);
  try {
    savePendingLogin(deps.storage, { verifier, state }, deps.now());
  } catch {
    throw new AuthError("storage_unavailable");
  }
  deps.navigate(authorizeUrl(config, state, challenge));
}

export type LoginReturn = { readonly status: "none" } | { readonly status: "signed_in"; readonly session: AuthSession };

const RETURN_PARAMS = ["code", "state", "error", "error_description", "error_uri"];

/**
 * Call once when the page loads. If the address is not a return from the
 * login, resolves `{ status: "none" }` and touches nothing. Otherwise it
 * removes the login parameters from the address first, then checks them and
 * trades the code for a session, or throws `AuthError`.
 */
export async function completeLogin(config: ServiceConfig | null, deps: AuthDeps): Promise<LoginReturn> {
  const url = new URL(deps.currentUrl());
  const params = url.searchParams;
  if (!RETURN_PARAMS.some((name) => params.has(name))) return { status: "none" };

  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  // Out of the address before anything can fail, so a reload, a bookmark or
  // a shared link never carries the code.
  // The login returns them in the query; the fragment is left to the page.
  for (const name of RETURN_PARAMS) params.delete(name);
  deps.replaceUrl(url.href);

  let pending: PendingLogin | null = null;
  if (deps.storage !== null) {
    try {
      pending = takePendingLogin(deps.storage, deps.now());
    } catch {
      throw new AuthError("storage_unavailable");
    }
  }
  if (config === null) throw new AuthError("config_missing");
  if (pending === null || state === null || state !== pending.state) throw new AuthError("state_mismatch");
  if (error !== null) throw new AuthError("login_failed", safeCode(error));
  if (code === null || code === "" || code.length > 2048) throw new AuthError("login_failed", "missing_code");

  return { status: "signed_in", session: await exchangeCode(config, code, pending.verifier, deps) };
}

async function exchangeCode(config: ServiceConfig, code: string, verifier: string, deps: AuthDeps): Promise<AuthSession> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.webClientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  let response: Response;
  const startedAt = deps.now();
  try {
    response = await deps.fetch(new URL("/oauth2/token", config.loginOrigin).href, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new AuthError("token_network");
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    // The body stalled past the deadline or the connection dropped.
    throw new AuthError("token_network");
  }
  let payload: unknown = null;
  try {
    if (text.length <= MAX_TOKEN_RESPONSE_CHARS) payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const fields = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  if (!response.ok) throw new AuthError("token_exchange", safeCode(fields["error"]) ?? `http_${response.status}`);

  // Only these two fields are read. The ID and refresh tokens in the same
  // answer are never copied anywhere and go away with `payload`.
  const accessToken = fields["access_token"];
  const tokenType = fields["token_type"];
  const expiresIn = fields["expires_in"];
  if (typeof accessToken !== "string" || !TOKEN_PATTERN.test(accessToken)) throw new AuthError("token_exchange", "bad_token");
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") throw new AuthError("token_exchange", "bad_token_type");
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthError("token_exchange", "bad_expiry");
  }
  // The service's tokens last 60 minutes; never trust a longer life than a day.
  const lifetimeMs = Math.min(expiresIn, 86_400) * 1000;
  return createSession(accessToken, startedAt + lifetimeMs);
}

/**
 * Signs out: forgets the token and any half-done login. If the build knows a
 * sign-out URL registered in the client, also ends the session at the login
 * page (otherwise the next "Entrar" may succeed without asking again).
 */
export function logout(config: ServiceConfig | null, session: AuthSession | null, deps: AuthDeps): void {
  session?.end("signed_out");
  if (deps.storage !== null) clearPendingLogin(deps.storage);
  if (config === null || config.logoutUri === null) return;
  const url = new URL("/logout", config.loginOrigin);
  url.searchParams.set("client_id", config.webClientId);
  url.searchParams.set("logout_uri", config.logoutUri);
  deps.navigate(url.href);
}

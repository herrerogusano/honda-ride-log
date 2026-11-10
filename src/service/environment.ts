/**
 * Which service, if any, this build talks to (docs/PLAN.md, section 10).
 *
 * The settings live in `environments.config.json`, one entry per Vite mode.
 * `vite.config.ts` validates the entry of the mode being built with
 * `parseEnvironment`, fails the build if it is incomplete or malformed, adds
 * its two origins to the `connect-src` of the security policy and hands the
 * entry to the page as `__RIDE_LOG_SERVICE__`. An entry whose three service
 * values are empty means demo only: no login, no request leaves the browser.
 *
 * None of these values is a secret, but those of a real deployment are not
 * written in the repository until the owner decides.
 */

export interface ServiceConfig {
  /** Address of `POST /mcp`: https, no query, no fragment, no trailing slash. */
  readonly mcpUrl: string;
  /** Origin of the managed login (Cognito), e.g. `https://example.auth.eu-west-1.amazoncognito.com`. */
  readonly loginOrigin: string;
  /** Public app client of the login: no secret. */
  readonly webClientId: string;
  /** Must match a callback URL of the client character for character. */
  readonly redirectUri: string;
  /** Sign-out URL registered in the client, or null to forget the token locally only. */
  readonly logoutUri: string | null;
  /**
   * Send `resource=<mcpUrl>` in the authorization request. Believed, not
   * verified, to be what gives the token the audience the service requires.
   */
  readonly sendResourceIndicator: boolean;
}

export type ServiceEnvironment = { readonly kind: "demo" } | { readonly kind: "service"; readonly config: ServiceConfig };

export const DEMO_ONLY: ServiceEnvironment = Object.freeze({ kind: "demo" });

/** A configuration problem, found at build time. Names the field, never its value. */
export class EnvironmentError extends Error {
  constructor(field: string, expected: string) {
    super(`environments.config.json: ${field} must be ${expected}`);
    this.name = "EnvironmentError";
  }
}

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = ["mcpUrl", "loginDomain", "webClientId", "redirectUri", "logoutUri", "sendResourceIndicator"];

function text(entry: Record<string, unknown>, field: string): string {
  const value = entry[field] ?? "";
  if (typeof value !== "string") throw new EnvironmentError(field, "a string");
  return value.trim();
}

function parseUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentError(field, "an absolute URL");
  }
  if (url.username !== "" || url.password !== "") throw new EnvironmentError(field, "a URL without credentials");
  // `new URL` accepts `*` in a host name; in the security policy that would be a wildcard.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) {
    throw new EnvironmentError(field, "a URL whose host name has only letters, digits, dots and hyphens");
  }
  if (url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) {
    throw new EnvironmentError(field, "a URL without query or fragment");
  }
  return url;
}

function httpsUrl(value: string, field: string): URL {
  const url = parseUrl(value, field);
  if (url.protocol !== "https:") throw new EnvironmentError(field, "an https URL");
  return url;
}

/** https, or plain http only for `localhost` (the login accepts no other loopback name). */
function returnUrl(value: string, field: string): string {
  const url = parseUrl(value, field);
  const local = url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) throw new EnvironmentError(field, "an https URL or http://localhost");
  // Compared character for character by the login: keep it exactly as written.
  if (url.href !== value) throw new EnvironmentError(field, "written in canonical form (for example with the final /)");
  return value;
}

/**
 * Reads one entry of `environments.config.json`. `null`, `undefined` or an
 * entry whose `mcpUrl`, `loginDomain` and `webClientId` are all empty gives
 * demo only. Anything half filled or malformed throws `EnvironmentError`.
 */
export function parseEnvironment(raw: unknown): ServiceEnvironment {
  if (raw === null || raw === undefined) return DEMO_ONLY;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new EnvironmentError("the entry", "an object or null");
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!FIELDS.includes(key)) throw new EnvironmentError(key, "one of the known fields");
  }
  const mcpUrl = text(entry, "mcpUrl");
  const loginDomain = text(entry, "loginDomain");
  const webClientId = text(entry, "webClientId");
  if (mcpUrl === "" && loginDomain === "" && webClientId === "") return DEMO_ONLY;
  if (mcpUrl === "" || loginDomain === "" || webClientId === "") {
    throw new EnvironmentError("mcpUrl, loginDomain and webClientId", "all filled or all empty");
  }

  const mcp = httpsUrl(mcpUrl, "mcpUrl");
  if (mcp.href !== mcpUrl || mcpUrl.endsWith("/")) {
    throw new EnvironmentError("mcpUrl", "written in canonical form, without a trailing slash");
  }
  const login = httpsUrl(loginDomain, "loginDomain");
  if (loginDomain !== login.origin && loginDomain !== `${login.origin}/`) {
    throw new EnvironmentError("loginDomain", "an origin only, without a path");
  }
  if (!CLIENT_ID.test(webClientId)) throw new EnvironmentError("webClientId", "letters, digits, - or _");

  const redirectUri = text(entry, "redirectUri");
  if (redirectUri === "") throw new EnvironmentError("redirectUri", "filled when the service is configured");
  const logoutUri = text(entry, "logoutUri");
  const sendResource = entry["sendResourceIndicator"] ?? true;
  if (typeof sendResource !== "boolean") throw new EnvironmentError("sendResourceIndicator", "true or false");

  const config: ServiceConfig = {
    mcpUrl,
    loginOrigin: login.origin,
    webClientId,
    redirectUri: returnUrl(redirectUri, "redirectUri"),
    logoutUri: logoutUri === "" ? null : returnUrl(logoutUri, "logoutUri"),
    sendResourceIndicator: sendResource,
  };
  return Object.freeze({ kind: "service", config: Object.freeze(config) });
}

/** The origins the page must be allowed to connect to: none in demo. */
export function connectOrigins(environment: ServiceEnvironment): string[] {
  if (environment.kind === "demo") return [];
  const origins = [new URL(environment.config.mcpUrl).origin, environment.config.loginOrigin];
  return [...new Set(origins)];
}

declare const __RIDE_LOG_SERVICE__: unknown;

/** The environment this page was built for (demo if the build injected none). */
export function currentEnvironment(): ServiceEnvironment {
  return parseEnvironment(typeof __RIDE_LOG_SERVICE__ === "undefined" ? null : __RIDE_LOG_SERVICE__);
}

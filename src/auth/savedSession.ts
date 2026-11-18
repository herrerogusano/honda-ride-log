/**
 * STORAGE EXCEPTION 4 (docs/PLAN.md, section 10, "El token"; ESLint lifts
 * the `sessionStorage` ban for this file alone, and only src/auth/login.ts
 * may import it).
 *
 * It keeps the access token and the time it expires, so that reloading the
 * page does not sign the rider out, and nothing else: never a route, a
 * figure, an email or an identifier. `sessionStorage` belongs to the tab and
 * goes away when the tab is closed. The entry is removed when the session
 * ends for any reason (sign-out, «Borrar mis datos», expiry by the clock, a
 * 401, `session_expired`), and at start if it has expired or is damaged.
 *
 * No counter script shares a page load with a stored token (src/boot.ts
 * seals them first), because any script in the page could read it.
 */
import { EXPIRY_MARGIN_MS, MAX_SESSION_MS, TOKEN_PATTERN } from "./session";

/** The two `Storage` methods used, plus removal, injectable for tests. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedSession {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

const KEY = "ride-log.session";

/** The browser's `sessionStorage`, or null if it is missing or blocked. */
export function browserTokenStorage(): TokenStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when storage is disabled.
    return null;
  }
}

export function saveSession(storage: TokenStorage, saved: SavedSession): void {
  storage.setItem(KEY, JSON.stringify({ token: saved.accessToken, expiresAt: saved.expiresAtMs }));
}

/**
 * The stored session if it is still usable at `nowMs` (with the same margin
 * as `AuthSession`), else null. An expired, damaged or too long-lived entry
 * is removed.
 */
export function readSavedSession(storage: TokenStorage, nowMs: number): SavedSession | null {
  const text = storage.getItem(KEY);
  if (text === null) return null;
  let saved: SavedSession | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) {
      const { token, expiresAt } = value as Record<string, unknown>;
      if (
        typeof token === "string" &&
        TOKEN_PATTERN.test(token) &&
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt) &&
        nowMs < expiresAt - EXPIRY_MARGIN_MS &&
        expiresAt - nowMs <= MAX_SESSION_MS
      ) {
        saved = { accessToken: token, expiresAtMs: expiresAt };
      }
    }
  } catch {
    saved = null;
  }
  if (saved === null) storage.removeItem(KEY);
  return saved;
}

/** Removes the stored session, if any. */
export function clearSavedSession(storage: TokenStorage): void {
  storage.removeItem(KEY);
}

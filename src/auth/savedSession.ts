/**
 * STORAGE EXCEPTION 4 (docs/PLAN.md, section 10, "El token" and "Los datos
 * de la cuenta"; ESLint lifts the `sessionStorage` ban for this file alone,
 * and only src/auth/login.ts may import it).
 *
 * It keeps two entries in the tab's `sessionStorage`, and nothing else:
 *
 * - `ride-log.session`: the access token and the time it expires, so that
 *   reloading the page does not sign the rider out.
 * - `ride-log.account` (since 2026-11-18, the owner's decision): the
 *   account's data as it came out of src/domain/sanitize.ts at sign-in (the
 *   route list's dates, km, durations, speeds and inferred-segment flags, and
 *   the vehicle's battery, odometer, last use, model and mileage), so that a
 *   reload paints at once without asking the service again. This file does
 *   not build or read that value: it stores the plain JSON value
 *   src/domain/sanitize.ts makes (`accountSnapshot`), which carries no
 *   trace, no start or end place, no route id, no email and no token, and
 *   hands it back to `restoreAccount` there, which checks it again.
 *
 * The data entry is bound to the token entry: each time a token is saved it
 * gets a new random `binding` (256 bits, made by the sign-in with Web Crypto,
 * unrelated to the token), recorded in both entries. The data is kept and
 * handed back only while a usable token entry with that same binding is
 * there; otherwise it is removed. Another session's data put under this token
 * does not match, even with the very same expiry. Both go together: whenever the token
 * entry is removed (the session ends for any reason, a new sign-in, a return
 * from the login, an expired or damaged entry at start) the data entry is
 * removed in the same call. `sessionStorage` belongs to the tab and goes
 * away when the tab is closed.
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
  /**
   * Random, made when the token was saved: the account data is kept for this
   * value alone. Null for an entry saved without one (an older page): its
   * token works, but no data is kept or handed back for it.
   */
  readonly binding: string | null;
}

const KEY = "ride-log.session";
const ACCOUNT_KEY = "ride-log.account";
/** What `randomToken` in src/auth/pkce.ts makes: 43 base64url characters. */
export const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The browser's `sessionStorage`, or null if it is missing or blocked. */
export function browserTokenStorage(): TokenStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when storage is disabled.
    return null;
  }
}

/**
 * Saves the token with a new binding (`BINDING_PATTERN`); whatever data an
 * earlier token left goes, since it is not this session's.
 */
export function saveSession(storage: TokenStorage, saved: SavedSession & { readonly binding: string }): void {
  storage.removeItem(ACCOUNT_KEY);
  if (!BINDING_PATTERN.test(saved.binding)) throw new TypeError("binding");
  storage.setItem(KEY, JSON.stringify({ token: saved.accessToken, expiresAt: saved.expiresAtMs, binding: saved.binding }));
}

/**
 * The stored session if it is still usable at `nowMs` (with the same margin
 * as `AuthSession`), else null. An expired, damaged or too long-lived entry
 * is removed, and the account data with it.
 */
export function readSavedSession(storage: TokenStorage, nowMs: number): SavedSession | null {
  const text = storage.getItem(KEY);
  if (text === null) {
    storage.removeItem(ACCOUNT_KEY);
    return null;
  }
  let saved: SavedSession | null = null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) {
      const { token, expiresAt, binding } = value as Record<string, unknown>;
      if (
        typeof token === "string" &&
        TOKEN_PATTERN.test(token) &&
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt) &&
        nowMs < expiresAt - EXPIRY_MARGIN_MS &&
        expiresAt - nowMs <= MAX_SESSION_MS
      ) {
        const bound = typeof binding === "string" && BINDING_PATTERN.test(binding) ? binding : null;
        saved = { accessToken: token, expiresAtMs: expiresAt, binding: bound };
        // No binding, no data: whatever is there was not kept for this token.
        if (bound === null) storage.removeItem(ACCOUNT_KEY);
      }
    }
  } catch {
    saved = null;
  }
  if (saved === null) clearSavedSession(storage);
  return saved;
}

/** Removes the stored session and the account data, if any. */
export function clearSavedSession(storage: TokenStorage): void {
  storage.removeItem(KEY);
  storage.removeItem(ACCOUNT_KEY);
}

/** Whether the token stored now, usable at `nowMs`, is the one saved with `binding`. */
function boundSession(storage: TokenStorage, binding: string, nowMs: number): boolean {
  const session = readSavedSession(storage, nowMs);
  return session !== null && session.binding !== null && session.binding === binding;
}

/**
 * Keeps `account` (the plain value of `accountSnapshot`) for the token saved
 * with `binding`, but only while that token is the one stored and still
 * usable at `nowMs`. Returns whether it was kept. A storage that refuses it
 * (quota) throws; the caller drops the entry and goes on.
 */
export function saveAccount(storage: TokenStorage, binding: string, account: unknown, nowMs: number): boolean {
  if (!boundSession(storage, binding, nowMs)) {
    storage.removeItem(ACCOUNT_KEY);
    return false;
  }
  storage.setItem(ACCOUNT_KEY, JSON.stringify({ binding, account }));
  return true;
}

/**
 * The account data kept for the token saved with `binding`, or null. It is
 * handed back only if that token entry is the one stored and usable, and the
 * data was kept with that same binding; damaged or foreign data is removed.
 * The value is untrusted: src/domain/sanitize.ts checks it before use.
 */
export function readSavedAccount(storage: TokenStorage, binding: string, nowMs: number): unknown {
  const bound = boundSession(storage, binding, nowMs);
  const text = storage.getItem(ACCOUNT_KEY);
  if (text === null) return null;
  try {
    const value: unknown = bound ? JSON.parse(text) : null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const saved = value as Record<string, unknown>;
      const { account } = saved;
      if (saved["binding"] === binding && account !== undefined && account !== null) return account;
    }
  } catch {
    // Damaged: removed below.
  }
  storage.removeItem(ACCOUNT_KEY);
  return null;
}

/** Removes the account data alone (the restored copy did not pass its checks). */
export function clearSavedAccount(storage: TokenStorage): void {
  storage.removeItem(ACCOUNT_KEY);
}

/**
 * The one file allowed to use `sessionStorage` (docs/PLAN.md, section 10;
 * ESLint enforces it). It keeps the PKCE verifier and the `state` of a
 * login while the browser goes to the login page and back, and (open service
 * only) one fixed word across the trip to its sign-out page; nothing else,
 * never a token. Each entry is removed when it is read, whatever it holds.
 */
import { VERIFIER_PATTERN } from "./pkce";

export interface PendingLogin {
  readonly verifier: string;
  readonly state: string;
}

/** The two `Storage` methods used, injectable for tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = "ride-log.pending-login";
/** A login left half done for longer than this is not resumed. */
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

/** The browser's `sessionStorage`, or null if it is missing or blocked. */
export function browserSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Some browsers throw on access when storage is disabled.
    return null;
  }
}

export function savePendingLogin(storage: StorageLike, pending: PendingLogin, nowMs: number): void {
  storage.setItem(KEY, JSON.stringify({ verifier: pending.verifier, state: pending.state, createdAt: nowMs }));
}

/** Reads and removes the pending login. Null if absent, expired or malformed. */
export function takePendingLogin(storage: StorageLike, nowMs: number): PendingLogin | null {
  let text: string | null;
  try {
    text = storage.getItem(KEY);
  } finally {
    storage.removeItem(KEY);
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { verifier, state, createdAt } = value as Record<string, unknown>;
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) return null;
  if (typeof state !== "string" || state.length < 16 || state.length > 128) return null;
  if (typeof createdAt !== "number" || !(nowMs - createdAt >= 0 && nowMs - createdAt <= PENDING_LOGIN_TTL_MS)) return null;
  return { verifier, state };
}

/** Removes any pending login, for example when the user signs out. */
export function clearPendingLogin(storage: StorageLike): void {
  storage.removeItem(KEY);
}

/**
 * The open service (docs/PLAN.md, section 18): one fixed word that crosses
 * the trip to the login's sign-out page and back, so the page can say that
 * deleting the data was not confirmed. No data, no code, no time but its own.
 */
export type LeaveNotice = "delete_unconfirmed";

const NOTICE_KEY = "ride-log.leave-notice";

export function saveLeaveNotice(storage: StorageLike, notice: LeaveNotice, nowMs: number): void {
  storage.setItem(NOTICE_KEY, JSON.stringify({ notice, createdAt: nowMs }));
}

/** Reads and removes the notice. Null if absent, older than 10 minutes or malformed. */
export function takeLeaveNotice(storage: StorageLike, nowMs: number): LeaveNotice | null {
  let text: string | null;
  try {
    text = storage.getItem(NOTICE_KEY);
  } finally {
    storage.removeItem(NOTICE_KEY);
  }
  if (text === null) return null;
  try {
    const { notice, createdAt } = JSON.parse(text) as Record<string, unknown>;
    if (notice !== "delete_unconfirmed") return null;
    if (typeof createdAt !== "number" || !(nowMs - createdAt >= 0 && nowMs - createdAt <= PENDING_LOGIN_TTL_MS)) return null;
    return notice;
  } catch {
    return null;
  }
}

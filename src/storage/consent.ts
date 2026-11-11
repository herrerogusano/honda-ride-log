/**
 * STORAGE EXCEPTION 3 (docs/PLAN.md, "Privacidad" and section 17; ESLint
 * lifts the `localStorage` ban, and the `document.cookie` ban, for this
 * file alone).
 *
 * It remembers the visitor's answer to the cookie notice, and nothing else:
 * "granted" or "denied" and the day it was given. Never a token, a route, a
 * figure or an identifier. An answer older than `CONSENT_MAX_AGE_MS` counts
 * as no answer, so the notice asks again.
 *
 * `document.cookie` is touched only to delete Google Analytics' own cookies
 * when the visitor withdraws consent; this file never writes a cookie of its
 * own.
 */

export type ConsentChoice = "granted" | "denied";

/** The storage key; a `storage` event with this key means another tab changed the answer. */
export const CONSENT_KEY = "ride-log.consent.v1";
/** About a year: the notice asks again after it. */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** The stored record, whatever its age, or null if there is none, it is damaged or storage is unavailable. */
function readRecord(): { readonly choice: ConsentChoice; readonly at: number } | null {
  try {
    const text = localStorage.getItem(CONSENT_KEY);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { choice, at } = parsed as Record<string, unknown>;
    if (choice !== "granted" && choice !== "denied") return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    return { choice, at };
  } catch {
    return null;
  }
}

/** The stored answer, or null if there is none, it is damaged, too old or storage is unavailable. */
export function readConsent(now: number): ConsentChoice | null {
  const record = readRecord();
  if (record === null || record.at > now || now - record.at > CONSENT_MAX_AGE_MS) return null;
  return record.choice;
}

/** True when there is an acceptance older than `CONSENT_MAX_AGE_MS`: its cookies outlived it. */
export function consentExpired(now: number): boolean {
  const record = readRecord();
  return record !== null && record.choice === "granted" && now - record.at > CONSENT_MAX_AGE_MS;
}

/** Stores the answer. False when the browser refuses (private mode, storage full or disabled). */
export function writeConsent(choice: ConsentChoice, now: number): boolean {
  if (choice !== "granted" && choice !== "denied") return false;
  // The day only: the exact time is not needed to know when to ask again.
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice, at: day }));
    return true;
  } catch {
    return false;
  }
}

/** Names of Google Analytics' cookies: `_ga` and `_ga_<container>`. */
const GOOGLE_COOKIE = /^_ga(_[A-Za-z0-9]+)?$/;

/**
 * Expires every Google Analytics cookie of this page, at the host and at
 * each parent domain the browser may have let it use. Returns how many it
 * found.
 */
export function deleteGoogleCookies(hostname: string): number {
  let names: string[];
  try {
    names = document.cookie
      .split(";")
      .map((part) => part.split("=")[0]?.trim() ?? "")
      .filter((name) => GOOGLE_COOKIE.test(name));
  } catch {
    return 0;
  }
  const labels = hostname.split(".");
  const domains = labels.map((_, index) => labels.slice(index).join(".")).filter((domain) => domain.includes("."));
  for (const name of names) {
    try {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
      for (const domain of domains) document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${domain}`;
    } catch {
      // Cookies disabled: there is nothing to delete.
    }
  }
  return names.length;
}

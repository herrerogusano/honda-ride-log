/**
 * Which visit counters, if any, this build has (docs/PLAN.md, section 17).
 *
 * The values live in `analytics.config.json`, one entry per Vite mode.
 * `vite.config.ts` validates the entry of the mode being built with
 * `parseAnalytics`, fails the build if it is malformed, adds the counters'
 * origins to the security policy and hands the entry to the page as
 * `__RIDE_LOG_ANALYTICS__`. Both values empty (the default) means no counter:
 * the page behaves as it did before and asks nothing of anyone.
 *
 * - Cloudflare Web Analytics: always on when its token is set. It sets no
 *   cookie and uses no browser storage, so it needs no consent.
 * - Google Analytics 4: only after the visitor accepts in the cookie notice.
 *   Without that, its script is never requested.
 */

/** Everything a counter is ever told, beyond the visit itself: a closed list, no parameters. */
export type AnalyticsEvent = "demo_open" | "login";

/**
 * What the page needs of a counter. `src/boot.ts` sees only this, so the
 * counters can be swapped (for example for a same-origin "signed in" ping)
 * or left out of a document without touching the page.
 */
export interface Counter {
  /** Called once the page has dealt with the return from the login: nothing of the sign-in is left in the address. */
  start(): void;
  track(event: AnalyticsEvent): void;
}

export interface AnalyticsConfig {
  /** Token of a Cloudflare Web Analytics site, or null. */
  readonly cloudflareToken: string | null;
  /** Google Analytics 4 measurement id (`G-...`), or null. */
  readonly googleMeasurementId: string | null;
}

export const NO_ANALYTICS: AnalyticsConfig = Object.freeze({ cloudflareToken: null, googleMeasurementId: null });

/** A configuration problem, found at build time. Names the field, never its value. */
export class AnalyticsConfigError extends Error {
  constructor(field: string, expected: string) {
    super(`analytics.config.json: ${field} must be ${expected}`);
    this.name = "AnalyticsConfigError";
  }
}

const FIELDS = ["cloudflareToken", "googleMeasurementId"];
const CLOUDFLARE_TOKEN = /^[a-f0-9]{32}$/;
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;

function value(entry: Record<string, unknown>, field: string, pattern: RegExp, expected: string): string | null {
  const raw = entry[field] ?? "";
  if (typeof raw !== "string") throw new AnalyticsConfigError(field, "a string");
  const text = raw.trim();
  if (text === "") return null;
  if (!pattern.test(text)) throw new AnalyticsConfigError(field, expected);
  return text;
}

/** Reads one entry of `analytics.config.json`; `null` or `undefined` gives no counter. */
export function parseAnalytics(raw: unknown): AnalyticsConfig {
  if (raw === null || raw === undefined) return NO_ANALYTICS;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AnalyticsConfigError("the entry", "an object or null");
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!FIELDS.includes(key)) throw new AnalyticsConfigError(key, "one of the known fields");
  }
  return Object.freeze({
    cloudflareToken: value(entry, "cloudflareToken", CLOUDFLARE_TOKEN, "32 lowercase hexadecimal characters"),
    googleMeasurementId: value(entry, "googleMeasurementId", MEASUREMENT_ID, "G- followed by capital letters and digits"),
  });
}

declare const __RIDE_LOG_ANALYTICS__: unknown;

/** The counters this page was built with (none if the build injected nothing). */
export function currentAnalytics(): AnalyticsConfig {
  return parseAnalytics(typeof __RIDE_LOG_ANALYTICS__ === "undefined" ? null : __RIDE_LOG_ANALYTICS__);
}

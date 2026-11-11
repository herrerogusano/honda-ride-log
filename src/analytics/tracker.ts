/**
 * The visit counters (docs/PLAN.md, section 17).
 *
 * What is sent, and only this: a visit, "demo opened" and "signed in". The
 * events are a closed list with no parameters of ours beyond the clean page
 * address, so no route, figure, identifier or fragment can ride along.
 *
 * - Nothing loads before `start()`, which `src/boot.ts` calls only after it
 *   has dealt with the return from the login.
 * - **A page load that arrived with login parameters loads no counter at
 *   all**, for its whole life. Removing `?code` and `?state` from the
 *   address (`history.replaceState`) does not remove them from the browser's
 *   navigation timing entry, which a counter script can read. So `start()`
 *   checks both the current address and the arrival address, and refuses if
 *   either carries a login parameter. A real sign-in always arrives that
 *   way, so with this login flow the "signed in" event is never sent.
 * - Cloudflare Web Analytics loads at `start()` when its token is set. No
 *   cookie, no storage, no consent needed. `spa: false`, so changing the
 *   fragment (`#demo`) is not counted as another visit.
 * - Google Analytics loads only if the visitor has accepted (now, on an
 *   earlier visit or in another tab). If they refuse, its script is never
 *   requested. If they withdraw after accepting, here or in another tab, it is
 *   switched off with Google's own `ga-disable-<id>` flag and its cookies are
 *   deleted; the script already in the page cannot be unloaded. An
 *   acceptance older than a year counts as none, and its cookies are deleted.
 * - The address given to Google is the origin and path only: no query, no
 *   fragment. The referrer, the origin of the previous page only.
 */
import { CONSENT_KEY, consentExpired, deleteGoogleCookies, readConsent, writeConsent, type ConsentChoice } from "../storage/consent";
import type { AnalyticsConfig, AnalyticsEvent, Counter } from "./config";

export const CLOUDFLARE_BEACON = "https://static.cloudflareinsights.com/beacon.min.js";
export const GOOGLE_TAG = "https://www.googletagmanager.com/gtag/js";

export interface Tracker extends Counter {
  readonly config: AnalyticsConfig;
  /** True when the build has a counter that needs the visitor's consent. */
  readonly needsConsent: boolean;
  /** Loads the counters this build has and the visitor allows. Call once the address is clean. */
  start(): void;
  track(event: AnalyticsEvent): void;
  /** The visitor's stored answer, or null if they have not answered (or it expired). */
  choice(): ConsentChoice | null;
  /** The visitor accepts Google Analytics: remembered, and loaded if the page has started. */
  grant(): void;
  /** The visitor refuses or withdraws: remembered, Google Analytics switched off and its cookies deleted. */
  deny(): void;
  /** Called after the answer changes, here or in another tab. */
  onChange(listener: () => void): void;
}

/** Parameters the login puts in the address on the way back (src/auth/login.ts). */
const LOGIN_PARAMS = ["code", "state", "error", "error_description", "error_uri"];

export function hasLoginParams(href: string): boolean {
  try {
    const params = new URL(href).searchParams;
    return LOGIN_PARAMS.some((name) => params.has(name));
  } catch {
    // An address that cannot be read is treated as unsafe.
    return true;
  }
}

/** The address this page load arrived at, as the browser's navigation timing entry keeps it. */
export function arrivalAddress(): string | null {
  try {
    const entry = performance.getEntriesByType("navigation")[0];
    return entry === undefined ? null : entry.name;
  } catch {
    return null;
  }
}

/** Origin and path of the page: never its query or fragment. */
export function cleanLocation(href: string): string {
  const url = new URL(href);
  return url.origin + url.pathname;
}

/** Origin of the previous page, or empty. */
export function cleanReferrer(referrer: string): string {
  try {
    const url = new URL(referrer);
    return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}/` : "";
  } catch {
    return "";
  }
}

type Gtag = (...args: unknown[]) => void;

export interface TrackerOptions {
  readonly now?: () => number;
  /** Only for tests: the arrival address (`arrivalAddress()` in the page). */
  readonly arrival?: () => string | null;
  /** Stops listening to other tabs when aborted (the page never aborts it). */
  readonly signal?: AbortSignal;
}

export function createTracker(config: AnalyticsConfig, options: TrackerOptions = {}): Tracker {
  const now = options.now ?? Date.now;
  const arrival = options.arrival ?? arrivalAddress;
  const googleId = config.googleMeasurementId;
  const disableFlag = googleId === null ? null : `ga-disable-${googleId}`;
  const flags = window as unknown as Record<string, unknown>;
  const listeners: (() => void)[] = [];
  let started = false;
  let gtag: Gtag | null = null;
  let choice: ConsentChoice | null = googleId === null ? null : readConsent(now());
  // An old acceptance is no acceptance, and the cookies it left go with it.
  if (googleId !== null && consentExpired(now())) deleteGoogleCookies(location.hostname);

  function addScript(src: string, attributes: Readonly<Record<string, string>> = {}): void {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    document.head.append(script);
  }

  function pageView(): void {
    gtag?.("event", "page_view", { page_location: cleanLocation(location.href), page_title: "Ride Log" });
  }

  function loadGoogle(): void {
    if (googleId === null || disableFlag === null) return;
    flags[disableFlag] = false;
    if (gtag === null) {
      const layer = ((flags["dataLayer"] as unknown[] | undefined) ??= []);
      // gtag.js reads `arguments` objects from the data layer, not arrays.
      gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        layer.push(arguments);
      };
      gtag("js", new Date(now()));
      gtag("config", googleId, {
        send_page_view: false,
        page_location: cleanLocation(location.href),
        page_referrer: cleanReferrer(document.referrer),
        page_title: "Ride Log",
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      });
      addScript(`${GOOGLE_TAG}?id=${encodeURIComponent(googleId)}`);
    }
    pageView();
  }

  /** Switches Google off and deletes its cookies, without touching the stored answer. */
  function stopGoogle(): void {
    if (disableFlag === null) return;
    if (gtag !== null) flags[disableFlag] = true;
    deleteGoogleCookies(location.hostname);
  }

  function changed(): void {
    for (const listener of listeners) listener();
  }

  if (googleId !== null) {
    // Another tab answered: follow it, so a withdrawal there stops sending here.
    window.addEventListener("storage", (event) => {
      if (event.key !== CONSENT_KEY && event.key !== null) return;
      const next = readConsent(now());
      if (next === choice) return;
      const before = choice;
      choice = next;
      if (next === "granted") {
        if (started) loadGoogle();
      } else if (before === "granted") {
        stopGoogle();
      }
      changed();
    }, options.signal === undefined ? {} : { signal: options.signal });
  }

  return {
    config,
    needsConsent: googleId !== null,
    start() {
      if (started) return;
      const arrived = arrival();
      if (hasLoginParams(location.href) || (arrived !== null && hasLoginParams(arrived))) return;
      started = true;
      if (config.cloudflareToken !== null) {
        addScript(CLOUDFLARE_BEACON, { "data-cf-beacon": JSON.stringify({ token: config.cloudflareToken, spa: false }) });
      }
      if (choice === "granted") loadGoogle();
    },
    choice: () => choice,
    grant() {
      if (googleId === null) return;
      writeConsent("granted", now());
      const before = choice;
      choice = "granted";
      if (started && before !== "granted") loadGoogle();
      changed();
    },
    deny() {
      if (googleId === null) return;
      writeConsent("denied", now());
      choice = "denied";
      stopGoogle();
      changed();
    },
    track(event) {
      if (!started || choice !== "granted" || gtag === null) return;
      gtag("event", event, { page_location: cleanLocation(location.href) });
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

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
 * - **One visit per page load.** The visit is the `page_view` that Google's
 *   own `config` command sends, with the clean address, and `config` runs
 *   once per page load. There is no `page_view` event of ours on top of it
 *   (before, `send_page_view: false` plus an explicit event was the only
 *   path to a visit; two were seen on acceptance), and accepting again after
 *   a withdrawal on the same page counts no new visit.
 * - **`seal()`: no counter shares a document with the open service's screen
 *   before the login** (docs/PLAN.md, section 18), where the email is typed.
 *   Once sealed, nothing more loads or is sent in this document, whatever
 *   the visitor answers in the cookie notice. It says whether a counter
 *   script was already added: a script in the page cannot be unloaded, so
 *   then `src/boot.ts` reloads the page into that screen, sealed from the
 *   start.
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
  seal(): boolean;
  /** The visitor's stored answer, or null if they have not answered (or it expired). */
  choice(): ConsentChoice | null;
  /** The visitor accepts Google Analytics: remembered, and loaded if the page has started. */
  grant(): void;
  /** The visitor refuses or withdraws: remembered, Google Analytics switched off and its cookies deleted. */
  deny(): void;
  /** Called after the answer changes, here or in another tab. */
  onChange(listener: () => void): void;
}

/**
 * Parameters of the login in an address: those it puts there on the way back
 * (src/auth/login.ts), and `login_hint`, the email the open service hands the
 * login page. This page never puts `login_hint` in its own address, but
 * anyone can open it with one, and a counter script could read it there.
 */
const LOGIN_PARAMS = ["code", "state", "error", "error_description", "error_uri", "login_hint"];

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
  /** No counter may load or send in this document any more (`seal()`). */
  let sealed = false;
  /** A counter script was added to this document: it cannot be taken out once it runs. */
  let added = false;
  /** Cloudflare's beacon, until it has run (it has no switch of its own). */
  let pendingBeacon: HTMLScriptElement | null = null;
  let gtag: Gtag | null = null;
  let choice: ConsentChoice | null = googleId === null ? null : readConsent(now());
  // An old acceptance is no acceptance, and the cookies it left go with it.
  if (googleId !== null && consentExpired(now())) deleteGoogleCookies(location.hostname);

  function addScript(src: string, attributes: Readonly<Record<string, string>> = {}): HTMLScriptElement {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    added = true;
    document.head.append(script);
    return script;
  }

  /**
   * Nothing more loads or is sent in this page load. Google, if loaded, is
   * switched off with its own flag. Cloudflare's beacon, if it has not run
   * yet, loses its token and leaves the document; one that already ran
   * cannot be stopped.
   */
  function sealNow(): void {
    sealed = true;
    if (gtag !== null && disableFlag !== null) flags[disableFlag] = true;
    if (pendingBeacon !== null) {
      pendingBeacon.removeAttribute("data-cf-beacon");
      pendingBeacon.remove();
      pendingBeacon = null;
    }
  }

  /**
   * True when nothing may load or be sent any more. After `start()`, the
   * address is read again before loading Google, switching it back on and
   * every event: a login parameter that appears in it later seals the rest of
   * this page load, even if it is cleaned afterwards.
   */
  function shut(): boolean {
    if (!sealed && hasLoginParams(location.href)) sealNow();
    return sealed;
  }

  function loadGoogle(): void {
    if (shut() || googleId === null || disableFlag === null) return;
    flags[disableFlag] = false;
    if (gtag === null) {
      const layer = ((flags["dataLayer"] as unknown[] | undefined) ??= []);
      // gtag.js reads `arguments` objects from the data layer, not arrays.
      gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        layer.push(arguments);
      };
      gtag("js", new Date(now()));
      // `config` sends the visit itself (`send_page_view` is on by default), with these values.
      gtag("config", googleId, {
        page_location: cleanLocation(location.href),
        page_referrer: cleanReferrer(document.referrer),
        page_title: "Ride Log",
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      });
      addScript(`${GOOGLE_TAG}?id=${encodeURIComponent(googleId)}`);
    }
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

  // A navigation inside the page (Back, a fragment) that brings a login
  // parameter into the address seals at once. `history.replaceState` fires
  // no event: such a change is caught at the next load, re-enable or send.
  for (const type of ["popstate", "hashchange"]) {
    window.addEventListener(type, () => void shut(), options.signal === undefined ? {} : { signal: options.signal });
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
      if (started || sealed) return;
      // A login parameter in the current or the arrival address seals the
      // whole page load: cleaning the address later does not reopen it. With
      // no arrival address (no Navigation Timing, or it failed) only the
      // current one can tell.
      const arrived = arrival();
      if (hasLoginParams(location.href) || (arrived !== null && hasLoginParams(arrived))) {
        sealNow();
        return;
      }
      started = true;
      if (config.cloudflareToken !== null && !shut()) {
        const beacon = addScript(CLOUDFLARE_BEACON, { "data-cf-beacon": JSON.stringify({ token: config.cloudflareToken, spa: false }) });
        pendingBeacon = beacon;
        beacon.addEventListener("load", () => {
          if (pendingBeacon === beacon) pendingBeacon = null;
        });
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
      if (shut() || !started || choice !== "granted" || gtag === null) return;
      gtag("event", event, { page_location: cleanLocation(location.href) });
    },
    seal() {
      // A Google already in the page stops sending too (the page reloads right after).
      sealNow();
      return added;
    },
    onChange(listener) {
      listeners.push(listener);
    },
  };
}

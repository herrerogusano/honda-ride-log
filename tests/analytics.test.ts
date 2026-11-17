// @vitest-environment jsdom
// The visit counters, the cookie notice and the stored answer
// (docs/PLAN.md, section 17), in jsdom. jsdom never fetches the scripts it is
// given, so these tests prove which scripts the page asks for and what it
// pushes to Google's data layer: not what Cloudflare's or Google's scripts
// then send, nor that either service accepts it.
/* eslint-disable no-restricted-globals, no-restricted-properties -- the test reads and resets the storage and cookies that src/storage/consent.ts writes */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import analyticsFile from "../analytics.config.json" with { type: "json" };
import { AnalyticsConfigError, NO_ANALYTICS, parseAnalytics, type AnalyticsConfig } from "../src/analytics/config";
import { mountConsentNotice } from "../src/analytics/consentNotice";
import { arrivalAddress, cleanLocation, cleanReferrer, createTracker, type TrackerOptions } from "../src/analytics/tracker";
import { CONSENT_KEY, CONSENT_MAX_AGE_MS, deleteGoogleCookies, readConsent, writeConsent } from "../src/storage/consent";
import { countingPromise } from "../src/ui/summary";
import { analyticsFor } from "../vite.config";

/** Synthetic identifiers only. */
const TOKEN = "0123456789abcdef0123456789abcdef";
const GA = "G-TEST1234";
const BOTH: AnalyticsConfig = { cloudflareToken: TOKEN, googleMeasurementId: GA };
const CLOUDFLARE_ONLY: AnalyticsConfig = { cloudflareToken: TOKEN, googleMeasurementId: null };
const GOOGLE_ONLY: AnalyticsConfig = { cloudflareToken: null, googleMeasurementId: GA };
const NOW = Date.UTC(2026, 10, 11, 12);

const CLOUDFLARE_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
const scripts = (): string[] => [...document.querySelectorAll("script")].map((one) => one.src);
const flags = (): Record<string, unknown> => window as unknown as Record<string, unknown>;
const layer = (): unknown[][] => ((flags()["dataLayer"] as IArguments[] | undefined) ?? []).map((one) => [...one]);

/** Each test's trackers stop listening to `storage` when it ends. */
let listening = new AbortController();
const newTracker = (config: AnalyticsConfig, options: TrackerOptions = {}) => createTracker(config, { signal: listening.signal, ...options });

beforeEach(() => {
  listening.abort();
  listening = new AbortController();
  history.replaceState(null, "", "/");
  localStorage.clear();
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
});

afterEach(() => {
  delete flags()["dataLayer"];
  Reflect.deleteProperty(flags(), `ga-disable-${GA}`);
  Reflect.deleteProperty(document, "referrer");
  vi.restoreAllMocks();
});

/** Another tab changing the stored answer: the browser fires `storage` in this one. */
function answerInAnotherTab(choice: "granted" | "denied"): void {
  writeConsent(choice, Date.now());
  window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }));
}

const COOKIES = (): string[] => document.cookie.split(";").map((one) => one.trim()).filter((one) => one !== "").sort();

describe("a page load that arrived from the login", () => {
  it("loads no counter, even after the address was cleaned, when it arrived with the code", () => {
    const tracker = newTracker(BOTH, { arrival: () => "http://localhost:3000/?code=synthetic&state=synthetic" });
    writeConsent("granted", Date.now());
    tracker.start();
    tracker.grant();
    tracker.track("login");
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("loads no counter when it arrived with a login error instead of a code", () => {
    const tracker = newTracker(CLOUDFLARE_ONLY, { arrival: () => "http://localhost:3000/?error=access_denied&state=synthetic" });
    tracker.start();
    expect(scripts()).toEqual([]);
    history.replaceState(null, "", "/?error=access_denied&state=synthetic");
    newTracker(CLOUDFLARE_ONLY, { arrival: () => null }).start();
    expect(scripts()).toEqual([]);
  });

  it("loads no counter when the address carries a login_hint (an email), now or on arrival, whatever the answer to the cookies", () => {
    writeConsent("granted", Date.now());
    history.replaceState(null, "", "/?login_hint=rider%40example.test");
    const here = newTracker(BOTH, { arrival: () => null });
    here.start();
    here.grant();
    expect(scripts()).toEqual([]);
    history.replaceState(null, "", "/");
    const arrived = newTracker(BOTH, { arrival: () => "http://localhost:3000/?login_hint=rider%40example.test" });
    arrived.start();
    arrived.grant();
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it.each(["login_hint=rider%40example.test", "code=synthetic", "state=synthetic", "error=access_denied"])(
    "with %s put in the address after start, accepting loads nothing and Cloudflare's beacon, not run yet, leaves the page without its token",
    (param) => {
      const tracker = newTracker(BOTH, { arrival: () => null });
      tracker.start();
      const beacon = document.head.querySelector("script");
      expect(scripts()).toEqual([CLOUDFLARE_BEACON_SRC]);
      history.replaceState(null, "", `/?${param}`);
      tracker.grant();
      answerInAnotherTab("granted");
      expect(scripts()).toEqual([]);
      expect(beacon?.isConnected).toBe(false);
      expect(beacon?.hasAttribute("data-cf-beacon")).toBe(false);
      expect(flags()["dataLayer"]).toBeUndefined();
    },
  );

  it.each(["login_hint=rider%40example.test", "code=synthetic", "state=synthetic", "error=access_denied"])(
    "with %s put in the address after Google loaded, nothing more is sent and accepting again does not switch it back on",
    (param) => {
      const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
      tracker.start();
      tracker.grant();
      const before = layer().length;
      history.replaceState(null, "", `/?${param}`);
      tracker.track("demo_open");
      expect(layer()).toHaveLength(before);
      // Google, already in the page, is switched off at once with its own flag.
      expect(flags()[`ga-disable-${GA}`]).toBe(true);
      tracker.deny();
      tracker.grant();
      expect(flags()[`ga-disable-${GA}`]).toBe(true);
      tracker.track("demo_open");
      expect(layer()).toHaveLength(before);
      // Cleaning the address afterwards does not reopen this page load.
      history.replaceState(null, "", "/");
      tracker.grant();
      tracker.track("demo_open");
      expect(layer()).toHaveLength(before);
      expect(flags()[`ga-disable-${GA}`]).toBe(true);
    },
  );

  it("reads the arrival address from the browser's navigation timing entry", () => {
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type) =>
      type === "navigation" ? [{ name: "http://localhost:3000/?code=synthetic&state=synthetic" } as PerformanceEntry] : [],
    );
    expect(arrivalAddress()).toBe("http://localhost:3000/?code=synthetic&state=synthetic");
    newTracker(CLOUDFLARE_ONLY).start();
    expect(scripts()).toEqual([]);
  });

  it("loads as usual when the arrival address is an ordinary one", () => {
    newTracker(CLOUDFLARE_ONLY, { arrival: () => "http://localhost:3000/?utm_source=x#demo" }).start();
    expect(scripts()).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
  });
});

describe("what Google is handed, exactly", () => {
  it("only the origin of a referrer with a path and a query, and no parameter of ours in events", () => {
    Object.defineProperty(document, "referrer", {
      configurable: true,
      get: () => "https://login.example.test/oauth2/authorize?client_id=synthetic&state=synthetic",
    });
    history.replaceState(null, "", "/app/?utm_source=x#demo");
    writeConsent("granted", NOW);
    const tracker = newTracker(GOOGLE_ONLY, { now: () => NOW, arrival: () => null });
    tracker.start();
    tracker.track("demo_open");
    tracker.track("login");
    expect(layer()).toEqual([
      ["js", new Date(NOW)],
      [
        "config",
        GA,
        // `config` sends the visit itself, with these values: no page_view event of ours on top.
        {
          page_location: "http://localhost:3000/app/",
          page_referrer: "https://login.example.test/",
          page_title: "Ride Log",
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
        },
      ],
      ["event", "demo_open", { page_location: "http://localhost:3000/app/" }],
      ["event", "login", { page_location: "http://localhost:3000/app/" }],
    ]);
  });

  /** The commands that count a visit: Google's `config` (which sends the page view) and any page_view event. */
  const visits = (): unknown[][] => layer().filter((one) => one[0] === "config" || one[1] === "page_view");

  it("counts the visit once when accepting twice", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    tracker.grant();
    expect(visits()).toEqual([["config", GA, expect.objectContaining({ page_location: "http://localhost:3000/" })]]);
  });

  it("counts one visit per page load: no page_view event of ours, and none again after withdrawing and accepting", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    tracker.deny();
    tracker.grant();
    answerInAnotherTab("granted");
    expect(visits()).toHaveLength(1);
    expect(layer().some((one) => one[1] === "page_view")).toBe(false);
    expect(layer()[1]?.[2]).not.toHaveProperty("send_page_view");
  });
});

describe("sealed for the open service's screen before the login", () => {
  it("sealed before starting: loads nothing and sends nothing, whatever the visitor answers here or in another tab", () => {
    writeConsent("granted", Date.now());
    const tracker = newTracker(BOTH, { arrival: () => null });
    expect(tracker.seal()).toBe(false);
    tracker.start();
    tracker.grant();
    answerInAnotherTab("granted");
    tracker.track("demo_open");
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("sealed after starting with nothing loaded (no answer yet): accepting stores the answer but loads nothing", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    expect(tracker.seal()).toBe(false);
    tracker.grant();
    expect(tracker.choice()).toBe("granted");
    expect(readConsent(Date.now())).toBe("granted");
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("says so when a counter is already in the page, and Google stops sending", () => {
    const cloudflare = newTracker(CLOUDFLARE_ONLY, { arrival: () => null });
    cloudflare.start();
    expect(cloudflare.seal()).toBe(true);
    document.head.replaceChildren();
    writeConsent("granted", Date.now());
    const google = newTracker(GOOGLE_ONLY, { arrival: () => null });
    google.start();
    const before = layer().length;
    expect(google.seal()).toBe(true);
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    google.track("demo_open");
    google.grant();
    expect(layer()).toHaveLength(before);
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
  });
});

describe("consent across tabs and over time", () => {
  it("follows a withdrawal made in another tab: Google stops sending and its cookies go", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    const changes: (string | null)[] = [];
    tracker.onChange(() => changes.push(tracker.choice()));
    tracker.start();
    tracker.grant();
    document.cookie = "_ga=GA1.1.synthetic; Path=/";
    answerInAnotherTab("denied");
    expect(tracker.choice()).toBe("denied");
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    expect(COOKIES()).toEqual([]);
    const before = layer().length;
    tracker.track("demo_open");
    expect(layer()).toHaveLength(before);
    expect(changes).toEqual(["granted", "denied"]);
  });

  it("follows an acceptance made in another tab, and closes the notice open here", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    const host = document.createElement("div");
    document.body.append(host);
    mountConsentNotice(host, tracker);
    tracker.start();
    expect(host.querySelector<HTMLElement>(".consent")?.hidden).toBe(false);
    answerInAnotherTab("granted");
    expect(scripts()).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
    expect(host.querySelector<HTMLElement>(".consent")?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".consent-prefs")?.textContent).toBe("Cookies");
    window.dispatchEvent(new StorageEvent("storage", { key: "another-key" }));
    expect(scripts()).toHaveLength(1);
  });

  it("closed by an answer in another tab while the focus was in it, moves the focus to «Cookies»", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    const host = document.createElement("div");
    document.body.append(host);
    mountConsentNotice(host, tracker);
    tracker.start();
    host.querySelector<HTMLButtonElement>(".consent-choice")?.focus();
    answerInAnotherTab("denied");
    expect(document.activeElement).toBe(host.querySelector(".consent-link"));
  });

  it("closed by an answer in another tab while the focus was elsewhere, leaves the focus where it was", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    const host = document.createElement("div");
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere, host);
    mountConsentNotice(host, tracker);
    tracker.start();
    elsewhere.focus();
    answerInAnotherTab("denied");
    expect(host.querySelector<HTMLElement>(".consent")?.hidden).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("ignores changes to other storage keys", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    writeConsent("denied", Date.now());
    window.dispatchEvent(new StorageEvent("storage", { key: "ride-log.maintenance.v1" }));
    expect(tracker.choice()).toBe("granted");
    expect(flags()[`ga-disable-${GA}`]).toBe(false);
  });

  it("deletes Google's cookies on refusal even when Google never loaded in this page", () => {
    document.cookie = "_ga=GA1.1.synthetic; Path=/";
    document.cookie = "_ga_TEST1234=GS1.1.synthetic; Path=/";
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.deny();
    expect(COOKIES()).toEqual([]);
  });

  it("deletes the cookies of an acceptance that has expired, and asks again", () => {
    writeConsent("granted", NOW - CONSENT_MAX_AGE_MS - 2 * 86_400_000);
    document.cookie = "_ga=GA1.1.synthetic; Path=/";
    document.cookie = "other=kept; Path=/";
    const tracker = newTracker(GOOGLE_ONLY, { now: () => NOW, arrival: () => null });
    expect(tracker.choice()).toBeNull();
    expect(COOKIES()).toEqual(["other=kept"]);
    tracker.start();
    expect(scripts()).toEqual([]);
  });

  it("keeps Google's cookies of a current acceptance", () => {
    writeConsent("granted", NOW);
    document.cookie = "_ga=GA1.1.synthetic; Path=/";
    newTracker(GOOGLE_ONLY, { now: () => NOW, arrival: () => null });
    expect(COOKIES()).toEqual(["_ga=GA1.1.synthetic"]);
  });
});

describe("analytics.config.json", () => {
  it("gives counters to the Cloudflare Pages build only: Cloudflare's site token and Google's public id", () => {
    // Changed on purpose on 2026-11-17: the Cloudflare Web Analytics site for my-ride-log.pages.dev exists.
    expect(analyticsFor("cloudflare").analytics).toEqual({
      cloudflareToken: "7c2d474d270d48a3ae8fcf5d6b73c24b",
      googleMeasurementId: "G-JVB68585NG",
    });
    for (const mode of ["production", "development", "demo", "test", "$comment"]) {
      expect(analyticsFor(mode).analytics).toEqual(NO_ANALYTICS);
    }
    expect(Object.keys(analyticsFile).sort()).toEqual(["$comment", "cloudflare"]);
  });

  it("reads synthetic identifiers and refuses malformed ones without echoing them", () => {
    expect(parseAnalytics({ cloudflareToken: ` ${TOKEN} `, googleMeasurementId: GA })).toEqual(BOTH);
    expect(parseAnalytics({ cloudflareToken: "", googleMeasurementId: "" })).toEqual(NO_ANALYTICS);
    expect(parseAnalytics(null)).toEqual(NO_ANALYTICS);
    expect(() => parseAnalytics({ cloudflareToken: "not-hex-not-32" })).toThrow(/cloudflareToken must be 32/);
    expect(() => parseAnalytics({ googleMeasurementId: "UA-1234-1" })).toThrow(/googleMeasurementId must be G-/);
    expect(() => parseAnalytics({ googleMeasurementId: "G-ab<script>" })).toThrow(AnalyticsConfigError);
    expect(() => parseAnalytics({ apiSecret: "x" })).toThrow(/apiSecret must be one of the known fields/);
    expect(() => parseAnalytics({ cloudflareToken: "zz" })).toThrow(/^(?!.*zz)/s);
    expect(() => parseAnalytics([])).toThrow(/the entry/);
  });
});

describe("without identifiers", () => {
  it("asks nothing of anyone and shows no notice", () => {
    const tracker = newTracker(NO_ANALYTICS);
    const host = document.createElement("div");
    document.body.append(host);
    mountConsentNotice(host, tracker);
    tracker.start();
    tracker.grant();
    tracker.track("login");
    tracker.track("demo_open");
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
    expect(host.hidden).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});

describe("Cloudflare Web Analytics", () => {
  it("loads its beacon at start, with spa off, and asks no consent", () => {
    const tracker = newTracker(CLOUDFLARE_ONLY);
    expect(tracker.needsConsent).toBe(false);
    expect(scripts()).toEqual([]);
    tracker.start();
    tracker.start();
    const beacon = document.querySelector("script");
    expect(scripts()).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
    expect(JSON.parse(beacon?.getAttribute("data-cf-beacon") ?? "")).toEqual({ token: TOKEN, spa: false });
    expect(flags()["dataLayer"]).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it("does not load while the address carries a return from the login", () => {
    history.replaceState(null, "", "/?code=synthetic&state=synthetic");
    const tracker = newTracker(BOTH, { arrival: () => null });
    tracker.start();
    expect(scripts()).toEqual([]);
    // Changed on 2026-11-17: a refusal seals the whole page load, so cleaning
    // the address and starting again loads nothing (docs/PLAN.md, section 17).
    history.replaceState(null, "", "/");
    tracker.start();
    tracker.grant();
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("a refusal for the arrival address alone seals too", () => {
    const tracker = newTracker(BOTH, { arrival: () => "http://localhost:3000/?login_hint=rider%40example.test" });
    tracker.start();
    tracker.start();
    tracker.grant();
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("switching Google back on reads the address again, on its own (no event in between)", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    tracker.deny();
    const before = layer().length;
    history.replaceState(null, "", "/?login_hint=rider%40example.test");
    tracker.grant();
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    expect(layer()).toHaveLength(before);
  });

  it("a navigation in the page that brings a login parameter switches Google off at once", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    expect(flags()[`ga-disable-${GA}`]).toBe(false);
    history.replaceState(null, "", "/?code=synthetic");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
  });

  it("a beacon that already ran stays (it cannot be stopped); one that has not, goes", () => {
    const ran = newTracker(CLOUDFLARE_ONLY, { arrival: () => null });
    ran.start();
    const beacon = document.head.querySelector("script");
    beacon?.dispatchEvent(new Event("load"));
    expect(ran.seal()).toBe(true);
    expect(beacon?.isConnected).toBe(true);
    document.head.replaceChildren();
    const pending = newTracker(CLOUDFLARE_ONLY, { arrival: () => null });
    pending.start();
    expect(pending.seal()).toBe(true);
    expect(scripts()).toEqual([]);
  });
});

describe("Google Analytics", () => {
  it("is never requested without consent, and refusing keeps it out", () => {
    const tracker = newTracker(BOTH);
    tracker.start();
    tracker.track("login");
    expect(scripts()).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
    tracker.deny();
    tracker.track("demo_open");
    expect(scripts()).toHaveLength(1);
    expect(flags()["dataLayer"]).toBeUndefined();
    expect(readConsent(Date.now())).toBe("denied");
  });

  it("loads after accepting, counts the visit with the clean address and only the listed events", () => {
    history.replaceState(null, "", "/some/path?utm_source=x#demo=heavy");
    const tracker = newTracker(GOOGLE_ONLY, { now: () => NOW });
    tracker.track("login");
    tracker.grant();
    expect(scripts()).toEqual([]);
    tracker.start();
    expect(scripts()).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
    tracker.track("demo_open");
    const sent = layer();
    expect(sent.map((one) => one.slice(0, 2))).toEqual([
      ["js", new Date(NOW)],
      ["config", GA],
      ["event", "demo_open"],
    ]);
    expect(sent[1]?.[2]).toMatchObject({ allow_google_signals: false, allow_ad_personalization_signals: false });
    const text = JSON.stringify(sent);
    expect(text).toContain('"page_location":"http://localhost:3000/some/path"');
    expect(text).not.toMatch(/utm_source|#|heavy|login/);
  });

  it("remembers an earlier yes and loads at start", () => {
    writeConsent("granted", Date.now());
    const tracker = newTracker(GOOGLE_ONLY);
    expect(tracker.choice()).toBe("granted");
    tracker.start();
    expect(scripts()).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
  });

  it("switches off and deletes its cookies when consent is withdrawn, and back on when given again", () => {
    const tracker = newTracker(GOOGLE_ONLY);
    tracker.start();
    tracker.grant();
    document.cookie = "_ga=GA1.1.synthetic; Path=/";
    document.cookie = "_ga_TEST1234=GS1.1.synthetic; Path=/";
    document.cookie = "other=kept; Path=/";
    tracker.deny();
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    expect(document.cookie).toBe("other=kept");
    const before = layer().length;
    tracker.track("login");
    expect(layer()).toHaveLength(before);
    tracker.grant();
    expect(flags()[`ga-disable-${GA}`]).toBe(false);
    expect(scripts()).toHaveLength(1);
    // Sending again, but the visit of this page was already counted.
    expect(layer()).toHaveLength(before);
    tracker.track("demo_open");
    expect(layer().at(-1)?.slice(0, 2)).toEqual(["event", "demo_open"]);
  });

  it("gives only the origin of the previous page and of this one", () => {
    expect(cleanReferrer("https://login.example.test/oauth2/authorize?client_id=x&state=y")).toBe("https://login.example.test/");
    expect(cleanReferrer("")).toBe("");
    expect(cleanReferrer("javascript:alert(1)")).toBe("");
    expect(cleanLocation("https://example.test/a/?code=1#demo")).toBe("https://example.test/a/");
  });
});

describe("the stored answer", () => {
  it("keeps only the answer and the day, and forgets it after a year", () => {
    expect(writeConsent("granted", NOW)).toBe(true);
    const stored = JSON.parse(localStorage.getItem("ride-log.consent.v1") ?? "") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["at", "choice"]);
    expect(stored["at"]).toBe(Date.UTC(2026, 10, 11));
    expect(readConsent(NOW)).toBe("granted");
    expect(readConsent(Date.UTC(2026, 10, 11) + CONSENT_MAX_AGE_MS + 1)).toBeNull();
    expect(readConsent(Date.UTC(2026, 10, 10))).toBeNull();
  });

  it("ignores damaged values", () => {
    for (const value of ["{", "null", '{"choice":"yes","at":0}', '{"choice":"granted"}', '{"choice":"granted","at":"x"}']) {
      localStorage.setItem("ride-log.consent.v1", value);
      expect(readConsent(NOW)).toBeNull();
    }
  });

  it("deletes Google's cookies only", () => {
    document.cookie = "_ga=1; Path=/";
    document.cookie = "_gat=1; Path=/";
    document.cookie = "_ga_ABC=1; Path=/";
    expect(deleteGoogleCookies("localhost")).toBe(2);
    expect(document.cookie).toBe("_gat=1");
  });
});

describe("the cookie notice", () => {
  function mount(config: AnalyticsConfig) {
    const tracker = newTracker(config);
    const host = document.createElement("div");
    host.hidden = true;
    document.body.append(host);
    mountConsentNotice(host, tracker);
    const notice = host.querySelector<HTMLElement>("section.consent");
    const prefs = host.querySelector<HTMLElement>(".consent-prefs");
    const button = (label: string): HTMLButtonElement => {
      const found = [...host.querySelectorAll("button")].find((one) => one.textContent === label);
      if (found === undefined) throw new Error(`no button ${label}`);
      return found;
    };
    return { tracker, host, notice, prefs, button };
  }

  it("asks with two equal buttons and says what is and is not counted", () => {
    const { host, notice, prefs, button } = mount(BOTH);
    expect(host.hidden).toBe(false);
    expect(notice?.hidden).toBe(false);
    expect(prefs?.hidden).toBe(true);
    const title = document.getElementById(notice?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Cookies");
    expect(document.getElementById(notice?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Esta web cuenta las visitas con Cloudflare Web Analytics, que no usa cookies. Si aceptas, también con Google Analytics, que guarda cookies en este navegador y envía a Google la visita y si abres la demo. Si rechazas, Google Analytics no se carga. Tus rutas, tus cifras y los datos de tu moto nunca salen de tu navegador.",
    );
    expect(button("Aceptar").className).toBe(button("Rechazar").className);
    expect(host.querySelector("[style]")).toBeNull();
  });

  it("accepting loads Google once the page has started, hides the notice and leaves a way back", () => {
    const { tracker, notice, prefs, button } = mount(GOOGLE_ONLY);
    tracker.start();
    expect(scripts()).toEqual([]);
    button("Aceptar").click();
    expect(scripts()).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
    expect(notice?.hidden).toBe(true);
    expect(prefs?.hidden).toBe(false);
    // Only a discreet «Cookies» stays: no line saying the answer.
    expect(prefs?.textContent).toBe("Cookies");
    expect(prefs?.textContent).not.toMatch(/Google Analytics|aceptado|rechazado/);
    expect(button("Cookies").getAttribute("aria-label")).toBe("Cookies: cambiar tu respuesta");
    expect(document.activeElement).toBe(button("Cookies"));
    // Withdrawing takes the same two clicks as accepting: «Cookies», then «Rechazar».
    button("Cookies").click();
    expect(notice?.hidden).toBe(false);
    expect(document.activeElement).toBe(button("Aceptar"));
    button("Rechazar").click();
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    expect(prefs?.textContent).toBe("Cookies");
    expect(readConsent(Date.now())).toBe("denied");
  });

  it("rejecting never requests Google's script", () => {
    const { tracker, button } = mount(GOOGLE_ONLY);
    tracker.start();
    button("Rechazar").click();
    expect(scripts()).toEqual([]);
    expect(flags()["dataLayer"]).toBeUndefined();
  });

  it("is not shown again once answered", () => {
    writeConsent("denied", Date.now());
    const { notice, prefs } = mount(GOOGLE_ONLY);
    expect(notice?.hidden).toBe(true);
    expect(prefs?.textContent).toBe("Cookies");
  });

  it("does not appear with Cloudflare alone, which needs no consent", () => {
    const { host } = mount(CLOUDFLARE_ONLY);
    expect(host.hidden).toBe(true);
    expect(host.childElementCount).toBe(0);
  });
});

describe("what the footer promises", () => {
  it("says exactly which counters this build has", () => {
    expect(countingPromise(NO_ANALYTICS)).toBe("Esta web no cuenta las visitas.");
    expect(countingPromise(CLOUDFLARE_ONLY)).toBe(
      "Las visitas se cuentan con Cloudflare Web Analytics, sin cookies. No se carga cuando entras con tu cuenta, así que no ve tus rutas, tus cifras ni los datos de tu moto.",
    );
    expect(countingPromise(BOTH)).toBe(
      "Las visitas se cuentan con Cloudflare Web Analytics, sin cookies. Si aceptas las cookies, también con Google Analytics, que además sabe si abres la demo. Ninguno de los dos se carga cuando entras con tu cuenta, así que no ven tus rutas, tus cifras ni los datos de tu moto.",
    );
    expect(countingPromise(GOOGLE_ONLY)).toBe(
      "Si aceptas las cookies, las visitas se cuentan con Google Analytics, que además sabe si abres la demo. No se carga cuando entras con tu cuenta, así que no ve tus rutas, tus cifras ni los datos de tu moto.",
    );
  });
});

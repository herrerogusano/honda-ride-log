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
        {
          send_page_view: false,
          page_location: "http://localhost:3000/app/",
          page_referrer: "https://login.example.test/",
          page_title: "Ride Log",
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
        },
      ],
      ["event", "page_view", { page_location: "http://localhost:3000/app/", page_title: "Ride Log" }],
      ["event", "demo_open", { page_location: "http://localhost:3000/app/" }],
      ["event", "login", { page_location: "http://localhost:3000/app/" }],
    ]);
  });

  it("counts the visit once when accepting twice", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    tracker.start();
    tracker.grant();
    tracker.grant();
    expect(layer().filter((one) => one[1] === "page_view")).toHaveLength(1);
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

  it("follows an acceptance made in another tab, and the line at the end of the page says so", () => {
    const tracker = newTracker(GOOGLE_ONLY, { arrival: () => null });
    const host = document.createElement("div");
    document.body.append(host);
    mountConsentNotice(host, tracker);
    tracker.start();
    answerInAnotherTab("granted");
    expect(scripts()).toEqual([`https://www.googletagmanager.com/gtag/js?id=${GA}`]);
    expect(host.querySelector(".consent-state")?.textContent).toBe("Google Analytics: aceptado.");
    window.dispatchEvent(new StorageEvent("storage", { key: "another-key" }));
    expect(scripts()).toHaveLength(1);
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
  it("gives counters to the Cloudflare Pages build only: Google's public id, no Cloudflare token yet", () => {
    expect(analyticsFor("cloudflare").analytics).toEqual({ cloudflareToken: null, googleMeasurementId: "G-JVB68585NG" });
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
    const tracker = newTracker(CLOUDFLARE_ONLY);
    tracker.start();
    expect(scripts()).toEqual([]);
    history.replaceState(null, "", "/");
    tracker.start();
    expect(scripts()).toHaveLength(1);
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
      ["event", "page_view"],
      ["event", "demo_open"],
    ]);
    expect(sent[1]?.[2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
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
    expect(layer().at(-1)?.slice(0, 2)).toEqual(["event", "page_view"]);
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
    expect(prefs?.textContent).toBe("Google Analytics: aceptado. Cambiar las cookies");
    expect(document.activeElement).toBe(button("Cambiar las cookies"));
    button("Cambiar las cookies").click();
    expect(notice?.hidden).toBe(false);
    expect(document.activeElement).toBe(button("Aceptar"));
    button("Rechazar").click();
    expect(flags()[`ga-disable-${GA}`]).toBe(true);
    expect(prefs?.textContent).toBe("Google Analytics: rechazado. Cambiar las cookies");
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
    expect(prefs?.textContent).toBe("Google Analytics: rechazado. Cambiar las cookies");
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

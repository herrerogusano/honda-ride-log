// @vitest-environment jsdom
// The sign-in and the /mcp client joined with the page (src/boot.ts), in
// jsdom against tests/fakeServer.ts. They prove the wiring as we read the
// contract: not that Cognito, its CORS or the real /mcp behave this way, and
// jsdom is not a browser (no layout, no security policy, no real navigation).
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLogin, type AuthDeps } from "../src/auth/login";
import { generateRider } from "../src/demo/generator";
import type { StorageLike } from "../src/auth/pendingLogin";
import { createTracker } from "../src/analytics/tracker";
import { boot, type BootAnalytics } from "../src/boot";
import { writeConsent } from "../src/storage/consent";
import { DEMO_ONLY, type ServiceConfig, type ServiceEnvironment } from "../src/service/environment";
import type { App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";
import { createTraceStore, type TraceStore } from "../src/ui/traceStore";
import type { RouteRef } from "../src/domain/model";
import { createFakeServer, TEST_CONFIG, type FakeServer } from "./fakeServer";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

/** The two entries that src/auth/savedSession.ts keeps in the tab: the token, and the account data bound to it. */
const SAVED_KEY = "ride-log.session";
const ACCOUNT_KEY = "ride-log.account";

// jsdom serves the page at http://localhost:3000/; the login sends the browser back there.
const CONFIG: ServiceConfig = Object.freeze({ ...TEST_CONFIG, redirectUri: "http://localhost:3000/" });
const SERVICE: ServiceEnvironment = Object.freeze({ kind: "service", config: CONFIG });

let root: HTMLElement;
let server: FakeServer;
let storage: MemoryStorage | null;
let navigations: string[];
let authCalls: number;
let mounted: App | null = null;
/** Map views the page created and released. */
const maps = { created: 0, destroyed: 0 };
/** Every store of whole traces the page made, with the routes it was asked for. */
let stores: { store: TraceStore; asked: RouteRef[] }[] = [];
/** The routes whose whole trace some store still holds. */
const held = (): RouteRef[] => stores.flatMap(({ store, asked }) => asked.filter((ref) => store.known(ref) !== undefined));
/** The session's expiry timers, run by hand. */
let expiryTimers: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
/** The tool named in a recorded /mcp request. */
const toolOf = (body: string): string => (JSON.parse(body) as { params: { name: string } }).params.name;

function deps(): AuthDeps {
  authCalls += 1;
  return {
    crypto: webcrypto as unknown as AuthDeps["crypto"],
    storage,
    fetch: server.fetch,
    currentUrl: () => location.href,
    replaceUrl: (url) => history.replaceState(null, "", url),
    navigate: (url) => void navigations.push(url),
    now: () => server.clock.now,
  };
}

async function start(environment: ServiceEnvironment, address = "/"): Promise<App> {
  history.replaceState(null, "", address);
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
  const surface = { show: () => undefined, clear: () => undefined, frame: (_lines: unknown, _fly: unknown, settled: () => void) => settled(), paint: () => undefined, resize: () => undefined, destroy: () => undefined };
  mounted = await boot({
    root,
    environment,
    ...(analyticsUnderTest === null ? {} : { analytics: analyticsUnderTest }),
    auth: deps,
    now: () => server.clock.now,
    demoDelayMs: 0,
    createTraces: (caller) => {
      const store = createTraceStore(caller);
      const entry = { store, asked: [] as RouteRef[] };
      stores.push(entry);
      return { ...store, get: (route) => (entry.asked.push(route.ref), store.get(route)) };
    },
    expiryTimer: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      expiryTimers.push(timer);
      return () => void (timer.cancelled = true);
    },
    createMap: (data, caller, options) => {
      const view = createMapView(data, caller, options, () => surface);
      maps.created += 1;
      return { ...view, destroy: () => ((maps.destroyed += 1), view.destroy()) };
    },
    mcp: {
      fetch: async (input, init) => {
        const answer = await server.fetch(input, init);
        await mcpGate?.(typeof init?.body === "string" ? toolOf(init.body) : "");
        afterMcpAnswer?.();
        return answer;
      },
      now: () => server.clock.now,
      sleep: async () => undefined,
      minIntervalMs: 0,
    },
  });
  return mounted;
}

/** The visit counters handed to `boot`, or none. */
let analyticsUnderTest: BootAnalytics | null = null;

/** Holds an /mcp answer, by tool name, before it reaches the client. */
let mcpGate: ((tool: string) => Promise<void>) | null = null;
/** Runs after each /mcp answer has reached the client. */
let afterMcpAnswer: (() => void) | null = null;

/** Signs in at the fake login: the page is left for the login and comes back with a code. */
async function signedIn(address = ""): Promise<App> {
  const landing = await start(SERVICE);
  button("Entrar").click();
  await vi.waitFor(() => expect(navigations).toHaveLength(1));
  const back = new URL(server.approve(navigations[0] ?? ""));
  landing.dispose();
  return start(SERVICE, back.pathname + back.search + address);
}

const text = (): string => document.body.textContent ?? "";
/** The whole page as markup, attributes included. */
const page = (): string => new XMLSerializer().serializeToString(document);
/** Labels of the buttons that can be seen (not inside something hidden). */
const buttons = (within: ParentNode = document): string[] =>
  [...within.querySelectorAll("button")].filter((one) => one.closest("[hidden]") === null).map((one) => one.textContent ?? "");
function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((one) => one.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}
const loaded = (): Promise<void> => vi.waitFor(() => expect(root.querySelector('nav[aria-label="Secciones"]')).not.toBeNull());
const alert = (): Promise<HTMLElement> =>
  vi.waitFor(() => {
    const found = root.querySelector<HTMLElement>('[role="alert"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
const mcpRequests = (): number => server.requests.filter((one) => one.url === CONFIG.mcpUrl).length;
const signOutButton = (): HTMLButtonElement => button("Salir");

beforeEach(() => {
  server = createFakeServer(CONFIG);
  storage = new MemoryStorage();
  navigations = [];
  authCalls = 0;
  maps.created = 0;
  maps.destroyed = 0;
  stores = [];
  expiryTimers = [];
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  mounted?.dispose();
  mounted = null;
  afterMcpAnswer = null;
  mcpGate = null;
  analyticsUnderTest = null;
  document.head.replaceChildren();
  delete (window as unknown as Record<string, unknown>)["dataLayer"];
});

describe("a build without a service", () => {
  it("offers the demo alone, with no sign-in button and no sign-in code run", async () => {
    await start(DEMO_ONLY);
    expect(text()).toContain("El acceso con tu cuenta todavía no está disponible");
    expect(buttons()).toEqual(["Ver la demo"]);
    expect(signOutButton().hidden).toBe(true);
    expect(authCalls).toBe(0);
    expect(server.requests).toEqual([]);
  });

  it("still opens the demo from the address", async () => {
    await start(DEMO_ONLY, "/#demo");
    await loaded();
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(false);
    expect(location.hash).toBe("#demo");
  });
});

describe("a build with a service", () => {
  it("offers to sign in and to see the demo, and sends nothing until asked", async () => {
    await start(SERVICE);
    expect(buttons()).toEqual(["Entrar", "Ver la demo"]);
    expect(signOutButton().hidden).toBe(true);
    expect(text()).not.toContain("todavía no está disponible");
    expect(server.requests).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it("goes to the login page when Entrar is pressed, keeping only the pending login", async () => {
    await start(SERVICE);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").origin).toBe(CONFIG.loginOrigin);
    expect([...(storage?.items.keys() ?? [])]).toHaveLength(1);
  });

  it("says why when the browser refuses session storage, without a retry button", async () => {
    storage = null;
    await start(SERVICE);
    button("Entrar").click();
    const panel = await alert();
    expect(panel.textContent).toContain("login/storage_unavailable");
    expect(buttons(panel)).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it("loads the account after the login, with the code out of the address and a sign-out button", async () => {
    await signedIn();
    // completeLogin ran before the page: neither code nor state stays in the address.
    expect(location.search).toBe("");
    await loaded();
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(true);
    expect(signOutButton().hidden).toBe(false);
    expect(root.querySelector(".content")?.textContent).not.toContain("datos de ejemplo");
    const token = server.issuedTokens[0] ?? "";
    expect(token).not.toBe("");
    const calls = server.requests.filter((one) => one.url === CONFIG.mcpUrl);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
    // The token is in no attribute nor text of the page, nor in the address.
    expect(page()).not.toContain(token);
    expect(location.href).not.toContain(token);
    // The pending login was used once and is gone; the tab keeps the token
    // and its expiry, and the account data bound to that expiry.
    expect([...(storage?.items.keys() ?? [])].sort()).toEqual([ACCOUNT_KEY, SAVED_KEY]);
    expect(Object.keys(JSON.parse(storage?.items.get(SAVED_KEY) ?? "{}") as object).sort()).toEqual(["binding", "expiresAt", "token"]);
    // Nor in the title.
    expect(document.title).not.toContain(token);
  });

  it("ignores #demo on the way back from the login and takes it out of the address", async () => {
    await signedIn("#demo=heavy");
    await loaded();
    expect(location.hash).toBe("");
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(true);
    // The demo was never started, not even for a moment: its selector was never moved to the scenario.
    expect(root.querySelector<HTMLSelectElement>(".demo-banner select")?.value).toBe("commuter");
  });

  it("never lets #demo typed in the address replace the account", async () => {
    await signedIn();
    await loaded();
    const before = mcpRequests();
    history.replaceState(null, "", "/#demo");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(location.hash).toBe("");
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(true);
    expect(root.querySelector('nav[aria-label="Secciones"]')).not.toBeNull();
    expect(mcpRequests()).toBe(before);
  });

  it("shows a return with another state as a sign-in error that asks to sign in again", async () => {
    await start(SERVICE, "/?code=synthetic-code&state=not-the-pending-one");
    expect(location.search).toBe("");
    const panel = await alert();
    expect(panel.textContent).toContain("login/state_mismatch");
    expect(panel.textContent).toContain("Vuelve a entrar");
    expect(buttons(panel)).toEqual([]);
    // The landing below it has the way back in.
    expect(buttons(root)).toContain("Entrar");
    expect(buttons(root)).not.toContain("Reintentar");
    expect(server.requests).toEqual([]);
  });

  it("shows a failed token exchange as a sign-in error, never with the code", async () => {
    const landing = await start(SERVICE);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    landing.dispose();
    server.tokenOverride = "network";
    await start(SERVICE, back.pathname + back.search);
    const panel = await alert();
    expect(panel.textContent).toContain("login/token_network");
    expect(page()).not.toContain(back.searchParams.get("code") ?? "-");
    expect(location.search).toBe("");
  });

  it.each([
    ["a 401", () => ({ status: 401, body: "{}" }), "status/reauth_required (unauthorized)"],
    ["a network failure", () => "network" as const, "status/reauth_required (network)"],
    ["a 403", () => ({ status: 403, body: "{}" }), "status/forbidden"],
  ])("after %s asks to sign in again, with no retry on the same token", async (_name, answer, code) => {
    server.mcpOverride = answer;
    await signedIn();
    const panel = await alert();
    expect(panel.textContent).toContain(code);
    expect(buttons(panel)).toEqual(["Volver a entrar"]);
    const sent = mcpRequests();
    expect(sent).toBe(1);
    button("Volver a entrar", panel).click();
    await vi.waitFor(() => expect(navigations).toHaveLength(2));
    expect(new URL(navigations[1] ?? "").pathname).toBe("/oauth2/authorize");
    expect(mcpRequests()).toBe(sent);
  });

  it("still offers to retry a failure the same token can get past", async () => {
    let first = true;
    server.mcpOverride = () => {
      if (!first) return null;
      first = false;
      return { status: 503, body: "{}" };
    };
    await signedIn();
    const panel = await alert();
    expect(panel.textContent).toContain("status/http_status (503)");
    expect(buttons(panel)).toEqual(["Reintentar"]);
    button("Reintentar", panel).click();
    await loaded();
  });

  it("asks to sign in again when the token expires mid-load", async () => {
    let calls = 0;
    afterMcpAnswer = () => {
      calls += 1;
      // After two answers, an hour passes: the session ends before the next request.
      if (calls === 2) server.clock.now += 3_600_000;
    };
    await signedIn();
    const panel = await alert();
    expect(panel.textContent).toContain("reauth_required (expired)");
    expect(buttons(panel)).toEqual(["Volver a entrar"]);
    expect(mcpRequests()).toBe(2);
  });

  it("offers a new sign-in, not a retry, when a route's trace fails after the session ended", async () => {
    await signedIn();
    await loaded();
    server.mcpOverride = () => ({ status: 401, body: "{}" });
    const firstRoute = root.querySelector<HTMLElement>(".row-button");
    expect(firstRoute).not.toBeNull();
    firstRoute?.click();
    const panel = await vi.waitFor(() => {
      const found = root.querySelector<HTMLElement>(".map-status [role='alert']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(panel.textContent).toContain("detail/reauth_required (unauthorized)");
    expect(buttons(panel)).toEqual(["Volver a entrar"]);
    // Leaving for the login clears the account first: a page restored with
    // Back shows the landing, not the old data.
    button("Volver a entrar", panel).click();
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    expect(maps.destroyed).toBe(maps.created);
    await vi.waitFor(() => expect(navigations).toHaveLength(2));
  });

  it("never starts the demo on a failed return that carries #demo", async () => {
    await start(SERVICE, "/?code=synthetic-code&state=not-the-pending-one#demo=heavy");
    await alert();
    expect(location.hash).toBe("");
    expect(root.querySelector<HTMLSelectElement>(".demo-banner select")?.value).toBe("commuter");
  });
});

/** Opens the first route of the list and waits until its whole trace is kept in memory. */
async function holdATrace(): Promise<void> {
  root.querySelector<HTMLElement>(".row-button")?.click();
  await vi.waitFor(() => expect(held()).toHaveLength(1));
}

describe("a reload keeps the session (docs/PLAN.md, section 10, «El token»)", () => {
  /** Leaves the signed-in page and loads it again at `address`, with only the tab's storage carried over. */
  async function reload(address = "/"): Promise<App> {
    mounted?.dispose();
    return start(SERVICE, address);
  }

  it("loads the account again with the same token, without going to the login", async () => {
    await signedIn();
    await loaded();
    const token = server.issuedTokens[0] ?? "";
    const before = mcpRequests();
    await reload();
    await loaded();
    expect(navigations).toHaveLength(1);
    expect(signOutButton().hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(true);
    // The account data kept in the tab paints the page; only the vehicle is asked for again, behind it.
    await vi.waitFor(() => expect(mcpRequests()).toBe(before + 2));
    // Opening a route still asks the service, with the same token.
    await holdATrace();
    const calls = server.requests.filter((one) => one.url === CONFIG.mcpUrl).slice(before);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(server.issuedTokens).toHaveLength(1);
    expect(page()).not.toContain(token);
    expect(location.href).not.toContain(token);
    expect(document.title).not.toContain(token);
  });

  it("never lets #demo in the reloaded address replace the account", async () => {
    await signedIn();
    await loaded();
    await reload("/#demo");
    await loaded();
    expect(root.querySelector<HTMLElement>(".demo-banner")?.hidden).toBe(true);
  });

  it("does not sign in with a kept token that expired, and removes it", async () => {
    await signedIn();
    await loaded();
    const before = mcpRequests();
    server.clock.now += 3_600_000 - 60_000;
    await reload();
    expect(buttons()).toEqual(["Entrar", "Ver la demo"]);
    expect(signOutButton().hidden).toBe(true);
    expect(storage?.items.size).toBe(0);
    expect(mcpRequests()).toBe(before);
  });

  it("forgets the kept token on «Salir», so the next reload shows the landing", async () => {
    await signedIn();
    await loaded();
    signOutButton().click();
    expect(storage?.items.size).toBe(0);
    await reload();
    expect(buttons()).toEqual(["Entrar", "Ver la demo"]);
  });

  it("forgets it when the clock ends the session in the page", async () => {
    await signedIn();
    await loaded();
    const timer = expiryTimers[expiryTimers.length - 1];
    server.clock.now += timer?.delayMs ?? 0;
    timer?.run();
    expect(storage?.items.size).toBe(0);
  });

  it("forgets it when the service no longer takes the token, also after a reload", async () => {
    await signedIn();
    await loaded();
    await reload();
    await loaded();
    expect(storage?.items.size).toBe(2);
    server.mcpOverride = () => ({ status: 401, body: "{}" });
    root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
    await vi.waitFor(() => expect(root.querySelector(".map-status [role='alert']")?.textContent).toContain("reauth_required (unauthorized)"));
    expect(storage?.items.size).toBe(0);
  });

  it("forgets it when the service says session_expired, offers «Volver a entrar», and a reload shows the landing", async () => {
    await signedIn();
    await loaded();
    await reload();
    await loaded();
    expect(storage?.items.size).toBe(2);
    // The exact text the MCP Python SDK sends for a tool error.
    server.mcpOverride = (request) => {
      const message = JSON.parse(request.body) as { id: number; params: { name: string } };
      const said = `Error executing tool ${message.params.name}: session_expired: the session ended`;
      return { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: said }], isError: true } }) };
    };
    root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
    const status = (): Element | null => root.querySelector(".map-status [role='alert']");
    await vi.waitFor(() => expect(status()?.textContent).toContain("tool_error (session_expired)"));
    expect(buttons(status() as Element)).toEqual(["Volver a entrar"]);
    expect(storage?.items.size).toBe(0);
    server.mcpOverride = null;
    await reload();
    expect(buttons()).toEqual(["Entrar", "Ver la demo"]);
  });
});

describe("a reload paints the account data kept in the tab (docs/PLAN.md, section 10, «Los datos de la cuenta»)", () => {
  async function reload(address = "/"): Promise<App> {
    mounted?.dispose();
    return start(SERVICE, address);
  }
  /** The tools named in the /mcp requests made since `from`. */
  const toolsSince = (from: number): string[] =>
    server.requests.filter((one) => one.url === CONFIG.mcpUrl).slice(from).map((one) => toolOf(one.body));
  const content = (): string => root.querySelector(".content")?.textContent ?? "";
  const rows = (): number => root.querySelectorAll(".routes-table tbody tr").length;
  function choosePeriod(value: string): void {
    const select = root.querySelector<HTMLSelectElement>(".period-select");
    if (select === null) throw new Error("no period select");
    select.value = value;
    select.dispatchEvent(new Event("change"));
  }
  /** The same synthetic rider the fake server answers with (tests/fakeServer.ts). */
  const rider = generateRider({ seed: 7, nowMs: Date.parse("2026-07-01T00:00:00Z") });

  /** Reloads, and waits until the vehicle read behind the painted page has been answered and shown. */
  async function reloadAndRefresh(): Promise<void> {
    const from = mcpRequests();
    await reload();
    await loaded();
    await vi.waitFor(() => expect(toolsSince(from)).toEqual(["get_vehicle_status", "get_vehicle_details"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("asks for nothing but the vehicle, never the route list, and the page, the period and the list work the same", async () => {
    await signedIn();
    await loaded();
    const shown = content();
    const listed = rows();
    choosePeriod("all");
    const allShown = content();
    const before = mcpRequests();
    await reload();
    await loaded();
    // Painted at once, from the tab.
    expect(rows()).toBe(listed);
    await vi.waitFor(() => expect(toolsSince(before)).toEqual(["get_vehicle_status", "get_vehicle_details"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows()).toBe(listed);
    expect(rows()).toBeGreaterThan(10);
    expect(content()).toBe(shown);
    choosePeriod("all");
    expect(content()).toBe(allShown);
    expect(toolsSince(before)).toEqual(["get_vehicle_status", "get_vehicle_details"]);
  });

  it("finds a kept route again with one light read per semester, then asks for its trace", async () => {
    await signedIn();
    await loaded();
    await reloadAndRefresh();
    const before = mcpRequests();
    const buttons = root.querySelectorAll<HTMLElement>(".row-button");
    buttons[0]?.click();
    await vi.waitFor(() => expect(held()).toHaveLength(1));
    expect(toolsSince(before)).toEqual(["list_routes", "get_route_detail"]);
    // The next row is in the same semester: no new list read.
    buttons[1]?.click();
    await vi.waitFor(() => expect(held()).toHaveLength(2));
    expect(toolsSince(before)).toEqual(["list_routes", "get_route_detail", "get_route_detail"]);
    // The detail asked for is the route's own: its id comes from the light read.
    const [lookup, first] = server.requests.filter((one) => one.url === CONFIG.mcpUrl).slice(before);
    const asked = (JSON.parse(first?.body ?? "{}") as { params: { arguments: { route_id: string } } }).params.arguments.route_id;
    const range = (JSON.parse(lookup?.body ?? "{}") as { params: { arguments: { from_time: string; to_time: string } } }).params.arguments;
    const route = rider.routes.find((one) => one.route_id === asked);
    expect(route).toBeDefined();
    const start = Date.parse(route?.started_at ?? "");
    expect(start >= Date.parse(range.from_time) && start < Date.parse(range.to_time)).toBe(true);
  });

  it("never keeps a trace, a place, a route id, the token or anything but the closed list of fields", async () => {
    await signedIn();
    await loaded();
    // Traces in memory, so a leak into the tab would show.
    root.querySelectorAll<HTMLElement>(".row-button")[0]?.click();
    await vi.waitFor(() => expect(held()).toHaveLength(1));
    await reload();
    await loaded();
    root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
    await vi.waitFor(() => expect(held()).toHaveLength(1));
    const kept = storage?.items.get(ACCOUNT_KEY) ?? "";
    expect(kept.length).toBeGreaterThan(100);
    const token = server.issuedTokens[0] ?? "";
    expect(kept).not.toContain(token);
    for (const route of rider.routes) expect(kept).not.toContain(route.route_id);
    // Not one coordinate of any trace, nor of its start and end points.
    const coordinates = new Set<string>();
    for (const route of rider.routes.slice(0, 40)) {
      const detail = rider.detail(route.route_id) as { geojson: { features: { geometry: { coordinates: unknown } }[] } };
      for (const feature of detail.geojson.features) for (const value of [feature.geometry.coordinates].flat(3)) {
        // Latitudes and longitudes, not a stray altitude or a 0.
        if (/\.\d{4,}/.test(String(value))) coordinates.add(String(value));
      }
    }
    expect(coordinates.size).toBeGreaterThan(100);
    for (const value of coordinates) expect(kept).not.toContain(value);
    for (const word of ["route_id", "geojson", "registration", "vin", "position", "email", "token"]) expect(kept).not.toContain(word);
    const value = JSON.parse(kept) as { binding: string; account: Record<string, unknown> };
    expect(Object.keys(value).sort()).toEqual(["account", "binding"]);
    expect(value.binding).toBe((JSON.parse(storage?.items.get(SAVED_KEY) ?? "{}") as { binding: string }).binding);
    expect(Object.keys(value.account).sort()).toEqual(["info", "routes", "skipped", "v", "vehicle"]);
    const routes = value.account["routes"] as unknown[][];
    expect(routes.every((one) => one.length === 6 && one.every((field) => field === null || ["number", "boolean"].includes(typeof field)))).toBe(true);
    expect((value.account["vehicle"] as unknown[]).length).toBe(4);
  });

  it("discards data another sign-in kept for a token with the very same expiry", async () => {
    await signedIn();
    await loaded();
    const other = storage?.items.get(ACCOUNT_KEY) ?? "";
    const otherExpiry = (JSON.parse(storage?.items.get(SAVED_KEY) ?? "{}") as { expiresAt: number }).expiresAt;
    // A second sign-in in the same tab at the same moment: a new token that expires at the same millisecond.
    await startLogin(CONFIG, deps());
    const back = new URL(server.approve(navigations[navigations.length - 1] ?? ""));
    mounted?.dispose();
    await start(SERVICE, back.pathname + back.search);
    await loaded();
    expect(server.issuedTokens).toHaveLength(2);
    expect((JSON.parse(storage?.items.get(SAVED_KEY) ?? "{}") as { expiresAt: number }).expiresAt).toBe(otherExpiry);
    await vi.waitFor(() => expect(storage?.items.has(ACCOUNT_KEY)).toBe(true));
    const mine = storage?.items.get(ACCOUNT_KEY) ?? "";
    // The first session's data put back under the second token.
    storage?.items.set(ACCOUNT_KEY, other);
    const before = mcpRequests();
    await reload();
    await loaded();
    expect(toolsSince(before)).toContain("list_routes");
    await vi.waitFor(() => expect(storage?.items.get(ACCOUNT_KEY)).toBe(mine));
    expect(mine).not.toBe(other);
  });

  it("asks for the vehicle in the background, never the route list, and shows and keeps what it says", async () => {
    await signedIn();
    await loaded();
    const battery = (): string => {
      const term = [...root.querySelectorAll(".plate dt")].find((one) => one.textContent === "Batería");
      return term?.parentElement?.querySelector(".tile-value")?.textContent ?? "";
    };
    expect(battery()).not.toBe("");
    expect(battery()).not.toContain("13");
    // The service now says the battery is at 13 %.
    server.mcpOverride = (request) => {
      const message = JSON.parse(request.body) as { id: number; params: { name: string } };
      if (message.params.name !== "get_vehicle_status") return null;
      const status = { ...rider.status, battery: 13 };
      return { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status, isError: false } }) };
    };
    const before = mcpRequests();
    await reload();
    await loaded();
    await vi.waitFor(() => expect(battery()).toContain("13"));
    expect(toolsSince(before)).toEqual(["get_vehicle_status", "get_vehicle_details"]);
    await vi.waitFor(() => expect((JSON.parse(storage?.items.get(ACCOUNT_KEY) ?? "{}") as { account: { vehicle: unknown[] } }).account.vehicle[1]).toBe(13));
  });

  it("keeps what was kept, with no error, when the background read of the vehicle fails", async () => {
    await signedIn();
    await loaded();
    const kept = storage?.items.get(ACCOUNT_KEY) ?? "";
    const shown = content();
    server.mcpOverride = () => ({ status: 503, body: "{}" });
    const before = mcpRequests();
    await reload();
    await loaded();
    await vi.waitFor(() => expect(toolsSince(before)).toContain("get_vehicle_status"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(content()).toBe(shown);
    expect(storage?.items.get(ACCOUNT_KEY)).toBe(kept);
    expect(toolsSince(before)).not.toContain("list_routes");
  });

  it("discards data kept for another token, loads from the service and keeps this session's", async () => {
    await signedIn();
    await loaded();
    const kept = JSON.parse(storage?.items.get(ACCOUNT_KEY) ?? "{}") as { binding: string; account: unknown };
    storage?.items.set(ACCOUNT_KEY, JSON.stringify({ ...kept, binding: `${kept.binding.slice(1)}x` }));
    const before = mcpRequests();
    await reload();
    await loaded();
    expect(toolsSince(before)).toContain("list_routes");
    expect(toolsSince(before)).toContain("get_vehicle_status");
    expect((JSON.parse(storage?.items.get(ACCOUNT_KEY) ?? "{}") as { binding: string }).binding).toBe(kept.binding);
  });

  it.each([
    ["not JSON", () => "{"],
    ["another version", (kept: string) => kept.replace('"v":1', '"v":2')],
    ["a route with a text", (kept: string) => kept.replace(/"routes":\[\[[0-9]+/, '"routes":[["x"')],
    ["a negative distance", (kept: string) => kept.replace(/"routes":\[\[([0-9]+),([0-9.e+null]+),/, '"routes":[[$1,$2,-4,')],
  ])("discards damaged data (%s) without an error, and loads from the service", async (_name, damage) => {
    await signedIn();
    await loaded();
    const kept = storage?.items.get(ACCOUNT_KEY) ?? "";
    const damaged = damage(kept);
    expect(damaged).not.toBe(kept);
    storage?.items.set(ACCOUNT_KEY, damaged);
    const before = mcpRequests();
    await reload();
    await loaded();
    expect(toolsSince(before)).toContain("list_routes");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    // Kept again, whole, after that load.
    expect(storage?.items.get(ACCOUNT_KEY)).toBe(kept);
  });

  it("keeps nothing and shows no error when the tab refuses the data (quota)", async () => {
    const tab = storage as MemoryStorage;
    const setItem = tab.setItem.bind(tab);
    tab.setItem = (key, value) => {
      if (key === ACCOUNT_KEY) throw new DOMException("full", "QuotaExceededError");
      setItem(key, value);
    };
    await signedIn();
    await loaded();
    expect(tab.items.has(SAVED_KEY)).toBe(true);
    expect(tab.items.has(ACCOUNT_KEY)).toBe(false);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    const before = mcpRequests();
    await reload();
    await loaded();
    expect(toolsSince(before)).toContain("list_routes");
  });

  it.each([
    ["«Salir»", async () => signOutButton().click()],
    ["the clock", async () => {
      const timer = expiryTimers[expiryTimers.length - 1];
      server.clock.now += timer?.delayMs ?? 0;
      timer?.run();
    }],
    ["a 401", async () => {
      server.mcpOverride = () => ({ status: 401, body: "{}" });
      root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
      await vi.waitFor(() => expect(root.querySelector(".map-status [role='alert']")).not.toBeNull());
    }],
    ["session_expired", async () => {
      server.mcpOverride = (request) => {
        const message = JSON.parse(request.body) as { id: number; params: { name: string } };
        const said = `Error executing tool ${message.params.name}: session_expired: the session ended`;
        return { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: said }], isError: true } }) };
      };
      root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
      await vi.waitFor(() => expect(root.querySelector(".map-status [role='alert']")).not.toBeNull());
    }],
    ["a 403", async () => {
      server.mcpOverride = () => ({ status: 403, body: "{}" });
      root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
      await vi.waitFor(() => expect(root.querySelector(".map-status [role='alert']")?.textContent).toContain("forbidden"));
    }],
    ["a reload with the token expired", async () => {
      server.clock.now += 3_600_000 - 60_000;
      await reload();
    }],
    ["a reload with the token damaged", async () => {
      storage?.items.set(SAVED_KEY, "{");
      await reload();
    }],
    ["a new sign-in", async () => {
      // What «Entrar» calls; the entries are still in the tab.
      await startLogin(CONFIG, deps());
    }],
    ["a return from the login", async () => {
      const kept = storage?.items.get(ACCOUNT_KEY) ?? "";
      const back = new URL(server.approve(navigations[0] ?? ""));
      mounted?.dispose();
      storage?.items.set(ACCOUNT_KEY, kept);
      await start(SERVICE, back.pathname + back.search);
    }],
  ])("is removed with the token on %s", async (_name, end) => {
    await signedIn();
    await loaded();
    expect(storage?.items.has(ACCOUNT_KEY)).toBe(true);
    await end();
    expect(storage?.items.has(ACCOUNT_KEY)).toBe(false);
  });
});

describe("the whole traces leave memory when the session ends (docs/PLAN.md, section 4)", () => {
  it("on «Salir»", async () => {
    await signedIn();
    await loaded();
    await holdATrace();
    signOutButton().click();
    expect(held()).toEqual([]);
  });

  it("when the token's time is up, with no request made", async () => {
    await signedIn();
    await loaded();
    await holdATrace();
    const sent = mcpRequests();
    const timer = expiryTimers[expiryTimers.length - 1];
    expect(timer?.cancelled).toBe(false);
    // The timer is set for the token's life less the margin; the clock gets there.
    server.clock.now += timer?.delayMs ?? 0;
    timer?.run();
    expect(held()).toEqual([]);
    expect(mcpRequests()).toBe(sent);
    // What is on screen stays; opening a route now asks to sign in again, sending nothing.
    expect(root.querySelector('nav[aria-label="Secciones"]')).not.toBeNull();
  });

  it("when the service no longer takes the token", async () => {
    await signedIn();
    await loaded();
    await holdATrace();
    server.mcpOverride = () => ({ status: 401, body: "{}" });
    root.querySelectorAll<HTMLElement>(".row-button")[1]?.click();
    await vi.waitFor(() => expect(root.querySelector(".map-status [role='alert']")?.textContent).toContain("reauth_required (unauthorized)"));
    expect(held()).toEqual([]);
  });

  it("but not while the session lasts: the timer asked early sets itself again", async () => {
    await signedIn();
    await loaded();
    await holdATrace();
    const timer = expiryTimers[expiryTimers.length - 1];
    timer?.run();
    expect(held()).toHaveLength(1);
    expect(expiryTimers.length).toBe(2);
  });
});

describe("signing out", () => {
  it("drops the data, forgets the token and goes back to the landing", async () => {
    await signedIn();
    await loaded();
    const sent = mcpRequests();
    const routeButton = root.querySelector<HTMLElement>(".row-button");
    expect([maps.created, maps.destroyed]).toEqual([1, 0]);
    signOutButton().click();
    // The map view is released with the traces it kept.
    expect(maps.destroyed).toBe(1);
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    expect(signOutButton().hidden).toBe(true);
    expect(buttons(root)).toContain("Entrar");
    expect(text()).not.toContain("Odómetro");
    // The client has forgotten the token: a route opened now (from a node
    // someone kept) asks nothing.
    routeButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mcpRequests()).toBe(sent);
    expect(navigations).toHaveLength(1);
  });

  it("in the middle of a load stops asking the service, even with requests waiting", async () => {
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    await signedIn();
    // The first request (the vehicle state) is in flight and held.
    await vi.waitFor(() => expect(mcpRequests()).toBe(1));
    signOutButton().click();
    release();
    server.hold = null;
    // Give the old load every chance to send its next request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mcpRequests()).toBe(1);
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain("Batería");
    expect(buttons(root)).toContain("Entrar");
  });

  it("another account loaded in the middle of a load stops the first one asking", async () => {
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const app = await signedIn();
    await vi.waitFor(() => expect(mcpRequests()).toBe(1));
    const second = createFakeServer(CONFIG);
    const asked: string[] = [];
    const other = { callTool: (name: Parameters<typeof second.tools.callTool>[0], args: never) => (asked.push(name), second.tools.callTool(name, args)) };
    const switched = app.load(other, { demo: false });
    release();
    server.hold = null;
    await switched;
    await loaded();
    // The first account's load got its held answer and asked nothing more.
    expect(mcpRequests()).toBe(1);
    expect(asked.slice(0, 2)).toEqual(["get_vehicle_status", "get_vehicle_details"]);
    expect(signOutButton().hidden).toBe(false);
  });

  it("another account loaded while the first reads its routes stops the first one there", async () => {
    // The first list_routes answer of the first account is held.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    mcpGate = async (tool) => {
      if (holding && tool === "list_routes") {
        holding = false;
        await held;
      }
    };
    const app = await signedIn();
    await vi.waitFor(() => expect(server.requests.some((one) => one.url === CONFIG.mcpUrl && toolOf(one.body) === "list_routes")).toBe(true));
    const second = createFakeServer(CONFIG);
    const switched = app.load(second.tools, { demo: false });
    release();
    await switched;
    await loaded();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstAccount = server.requests.filter((one) => one.url === CONFIG.mcpUrl).map((one) => toolOf(one.body));
    expect(firstAccount).toEqual(["get_vehicle_status", "get_vehicle_details", "list_routes"]);
  });

  it("leaves for the login's sign-out page when the build knows one", async () => {
    const withLogout: ServiceEnvironment = { kind: "service", config: { ...CONFIG, logoutUri: "http://localhost:3000/" } };
    const landing = await start(withLogout);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    landing.dispose();
    await start(withLogout, back.pathname + back.search);
    await loaded();
    signOutButton().click();
    const out = new URL(navigations[1] ?? "");
    expect(out.origin + out.pathname).toBe(`${CONFIG.loginOrigin}/logout`);
    expect(out.searchParams.get("logout_uri")).toBe("http://localhost:3000/");
  });
});

describe("visit counters (docs/PLAN.md, section 17)", () => {
  /** What a fake counter saw: each call and the query string of the address at that moment. */
  let seen: string[];
  const recorder = (): BootAnalytics => ({
    start: () => void seen.push(`start ${location.search}`),
    track: (event) => void seen.push(`${event} ${location.search}`),
    seal: () => {
      seen.push(`seal ${location.search}`);
      return false;
    },
  });
  beforeEach(() => {
    seen = [];
  });

  it("are sealed before they start in the page that came back from the login, with the address already clean", async () => {
    const landing = await start(SERVICE);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    expect(back.searchParams.has("code")).toBe(true);
    landing.dispose();
    analyticsUnderTest = recorder();
    await start(SERVICE, back.pathname + back.search);
    // That page holds a token (and soon the account): no sign-in is counted.
    expect(seen).toEqual(["seal ", "start "]);
  });

  it("start after a failed return too, without counting a sign-in", async () => {
    analyticsUnderTest = recorder();
    await start(SERVICE, "/?code=synthetic-code&state=not-the-pending-one");
    await alert();
    expect(seen).toEqual(["start "]);
  });

  it("count the demo when it opens, in a build without a service", async () => {
    analyticsUnderTest = recorder();
    await start(DEMO_ONLY, "/#demo");
    await loaded();
    expect(seen).toEqual(["start ", "demo_open "]);
  });

  it("load no counter at all in the page that came back from the login, with the account on screen", async () => {
    const landing = await start(SERVICE);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    landing.dispose();
    writeConsent("granted", Date.now());
    // A browser keeps the arrival address, code included, in its navigation timing entry.
    analyticsUnderTest = createTracker(
      { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" },
      { arrival: () => back.href },
    );
    await start(SERVICE, back.pathname + back.search);
    await loaded();
    expect(location.search).toBe("");
    expect(document.head.querySelectorAll("script")).toHaveLength(0);
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
  });

  it("load none in the page that came back from the login even where the browser keeps no arrival address", async () => {
    const landing = await start(SERVICE);
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    landing.dispose();
    writeConsent("granted", Date.now());
    analyticsUnderTest = createTracker(
      { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" },
      { arrival: () => null },
    );
    await start(SERVICE, back.pathname + back.search);
    await loaded();
    expect(document.head.querySelectorAll("script")).toHaveLength(0);
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
  });

  it("load none in a reload with a token kept in the tab, whatever the answer to the cookies, and none after the reload either", async () => {
    await signedIn();
    await loaded();
    mounted?.dispose();
    writeConsent("granted", Date.now());
    const counters = createTracker(
      { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" },
      { arrival: () => "http://localhost:3000/" },
    );
    analyticsUnderTest = counters;
    await start(SERVICE, "/");
    await loaded();
    // Accepting again in this page changes nothing.
    counters.grant();
    expect(document.head.querySelectorAll("script")).toHaveLength(0);
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
    // Once the rider signs out, the next page load has no token: the counters may start there.
    signOutButton().click();
    expect(storage?.items.size).toBe(0);
    mounted?.dispose();
    analyticsUnderTest = createTracker(
      { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" },
      { arrival: () => "http://localhost:3000/" },
    );
    await start(SERVICE, "/");
    expect(document.head.querySelectorAll("script")).toHaveLength(2);
  });

  it("start as before in a reload whose kept token has expired", async () => {
    await signedIn();
    await loaded();
    mounted?.dispose();
    server.clock.now += 3_600_000;
    analyticsUnderTest = recorder();
    await start(SERVICE, "/");
    expect(seen).toEqual(["start "]);
  });
});

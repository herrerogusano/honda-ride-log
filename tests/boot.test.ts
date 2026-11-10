// @vitest-environment jsdom
// The sign-in and the /mcp client joined with the page (src/boot.ts), in
// jsdom against tests/fakeServer.ts. They prove the wiring as we read the
// contract: not that Cognito, its CORS or the real /mcp behave this way, and
// jsdom is not a browser (no layout, no security policy, no real navigation).
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/auth/login";
import type { StorageLike } from "../src/auth/pendingLogin";
import { boot } from "../src/boot";
import { DEMO_ONLY, type ServiceConfig, type ServiceEnvironment } from "../src/service/environment";
import type { App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";
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

// jsdom serves the page at http://localhost:3000/; the login sends the browser back there.
const CONFIG: ServiceConfig = Object.freeze({ ...TEST_CONFIG, redirectUri: "http://localhost:3000/" });
const SERVICE: ServiceEnvironment = Object.freeze({ kind: "service", config: CONFIG });

let root: HTMLElement;
let server: FakeServer;
let storage: MemoryStorage | null;
let navigations: string[];
let authCalls: number;
let mounted: App | null = null;

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
  const surface = { show: () => undefined, clear: () => undefined, resize: () => undefined, destroy: () => undefined };
  mounted = await boot({
    root,
    environment,
    auth: deps,
    now: () => server.clock.now,
    demoDelayMs: 0,
    createMap: (data, caller, options) => createMapView(data, caller, options, () => surface),
    mcp: {
      fetch: async (input, init) => {
        const answer = await server.fetch(input, init);
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
const loaded = (): Promise<void> => vi.waitFor(() => expect(root.querySelector('[role="tablist"]')).not.toBeNull());
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
    // The pending login was used once and is gone.
    expect(storage?.items.size).toBe(0);
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
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
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
  });
});

describe("signing out", () => {
  it("drops the data, forgets the token and goes back to the landing", async () => {
    await signedIn();
    await loaded();
    const sent = mcpRequests();
    const routeButton = root.querySelector<HTMLElement>(".row-button");
    signOutButton().click();
    expect(root.querySelector('[role="tablist"]')).toBeNull();
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
    expect(root.querySelector('[role="tablist"]')).toBeNull();
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

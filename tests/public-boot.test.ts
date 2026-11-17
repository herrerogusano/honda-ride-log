// @vitest-environment jsdom
// The open service (docs/PLAN.md, section 18) joined with the page: the
// screen before the login, the pass, the login hint, signing out with
// cerrar_sesion and deleting with borrar_mis_datos. In jsdom against
// tests/fakeServer.ts and a fake Turnstile check: they prove the wiring as we
// read the service's contract, not that Cloudflare, Cognito or the real
// endpoints behave this way. jsdom has no layout and no security policy.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "../src/auth/login";
import type { StorageLike } from "../src/auth/pendingLogin";
import type { ChallengeCallbacks, ChallengeRenderer } from "../src/access/turnstile";
import { renderTurnstile, TURNSTILE_ACTION, TURNSTILE_SCRIPT } from "../src/access/turnstile";
import { boot } from "../src/boot";
import type { ServiceConfig, ServiceEnvironment } from "../src/service/environment";
import type { App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";
import { createFakeServer, PUBLIC_CONFIG, TEST_CONFIG, type FakeServer } from "./fakeServer";

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

// jsdom serves the page at http://localhost:3000/.
const CONFIG: ServiceConfig = Object.freeze({ ...PUBLIC_CONFIG, redirectUri: "http://localhost:3000/", logoutUri: "http://localhost:3000/" });
const PUBLIC: ServiceEnvironment = Object.freeze({ kind: "service", config: CONFIG });
const INVITATION: ServiceEnvironment = Object.freeze({ kind: "service", config: { ...TEST_CONFIG, redirectUri: "http://localhost:3000/" } });

let root: HTMLElement;
let server: FakeServer;
let navigations: string[];
let mounted: App | null = null;

/** The fake check: records each widget; the test resolves it by hand. */
interface FakeWidget {
  readonly siteKey: string;
  readonly callbacks: ChallengeCallbacks;
  resets: number;
  removed: boolean;
}
let widgets: FakeWidget[];
let challengeFails: boolean;
const challenge: ChallengeRenderer = async (host, siteKey, callbacks) => {
  if (challengeFails) throw new Error("turnstile_unavailable");
  const widget: FakeWidget = { siteKey, callbacks, resets: 0, removed: false };
  widgets.push(widget);
  host.append(document.createElement("iframe"));
  return {
    reset: () => void (widget.resets += 1),
    remove: () => void (widget.removed = true),
  };
};

function deps(): AuthDeps {
  return {
    crypto: webcrypto as unknown as AuthDeps["crypto"],
    storage: storageForTab,
    fetch: async (input, init) => {
      if (holdStatus !== null && String(input).endsWith("/estado")) await holdStatus;
      return server.fetch(input, init);
    },
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
  const surface = { show: () => undefined, clear: () => undefined, frame: (_l: unknown, _f: unknown, settled: () => void) => settled(), paint: () => undefined, resize: () => undefined, destroy: () => undefined };
  mounted = await boot({
    root,
    environment,
    auth: deps,
    challenge,
    now: () => server.clock.now,
    demoDelayMs: 0,
    createMap: (data, caller, options) => createMapView(data, caller, options, () => surface),
    mcp: { fetch: server.fetch, now: () => server.clock.now, sleep: async () => undefined, minIntervalMs: 0 },
  });
  return mounted;
}

const text = (): string => document.body.textContent ?? "";
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((one) => one.textContent === label && one.closest("[hidden]") === null);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}
const visibleButtons = (): string[] => [...document.querySelectorAll("button")].filter((one) => one.closest("[hidden]") === null).map((one) => one.textContent ?? "");
const emailField = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[type="email"]') as HTMLInputElement;
const consentBox = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement;
const form = (): HTMLFormElement => root.querySelector("form") as HTMLFormElement;
const submit = (): void => void form().dispatchEvent(new Event("submit", { cancelable: true }));
const passRequests = (): number => server.requests.filter((one) => one.url === CONFIG.publicAccess?.passUrl).length;

/** Landing → «Entrar» → the form is on screen (status `abierto`). */
async function openForm(): Promise<void> {
  await start(PUBLIC);
  button("Entrar").click();
  await vi.waitFor(() => expect(form()).not.toBeNull());
  await vi.waitFor(() => expect(widgets).toHaveLength(1));
}

/** Fills the form and passes the fake check. */
function fill(email = "Rider@Example.test"): void {
  consentBox().checked = true;
  emailField().value = email;
  widgets.at(-1)?.callbacks.onResult("synthetic-result-0001");
}

/** Through the pass and the fake login, back on the page with a session and the rider loaded. */
async function signedIn(): Promise<void> {
  await openForm();
  fill();
  submit();
  await vi.waitFor(() => expect(navigations).toHaveLength(1));
  const back = new URL(server.approve(navigations[0] ?? ""));
  mounted?.dispose();
  navigations = [];
  // The fake login keeps the pending login of this tab: reuse the same storage by going through `deps` again.
  await start(PUBLIC, back.pathname + back.search);
}

let storageForTab: MemoryStorage;
/** Holds the answer of /estado while set. */
let holdStatus: Promise<void> | null = null;
/** What the page put in localStorage (a fake). */
let store = new Map<string, string>();

beforeEach(() => {
  server = createFakeServer(CONFIG);
  navigations = [];
  widgets = [];
  challengeFails = false;
  storageForTab = new MemoryStorage();
  holdStatus = null;
  store = new Map<string, string>();
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
});

describe("the screen before the login", () => {
  it("asks /estado first and shows the consent, the email and the check; nothing is loaded before «Entrar»", async () => {
    await start(PUBLIC);
    expect(server.requests).toHaveLength(0);
    expect(widgets).toHaveLength(0);
    button("Entrar").click();
    expect(text()).toContain("Comprobando si se puede entrar…");
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(server.requests.map((one) => one.url)).toEqual(["https://api.example.test/estado"]);
    expect(text()).toContain("Texto provisional.");
    expect(text()).toContain("Correo de tu cuenta de MAPIT");
    expect(emailField().getAttribute("autocomplete")).toBe("email");
    await vi.waitFor(() => expect(widgets).toHaveLength(1));
    expect(widgets[0]?.siteKey).toBe("0x4AAAAAAASyntheticKey");
    expect(navigations).toEqual([]);
  });

  it.each([
    ["cerrado", "Ahora mismo no se admiten entradas."],
    ["pausa", "Estamos haciendo mantenimiento; vuelve más tarde."],
    ["network", "No se ha podido comprobar si se puede entrar."],
  ] as const)("with /estado %s says so, offers no form and no check", async (status, message) => {
    server.status = status;
    await start(PUBLIC);
    button("Entrar").click();
    await vi.waitFor(() => expect(text()).toContain(message));
    expect(form()).toBeNull();
    expect(widgets).toHaveLength(0);
    expect(visibleButtons()).toContain("Comprobar otra vez");
    server.status = "abierto";
    button("Comprobar otra vez").click();
    await vi.waitFor(() => expect(form()).not.toBeNull());
  });

  it("with /estado lleno still lets people in, and says new people have no seat", async () => {
    server.status = "lleno";
    await start(PUBLIC);
    button("Entrar").click();
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(text()).toContain("No quedan plazas para personas nuevas");
  });

  it("asks for nothing until the consent is given, the email is valid and the check passed", async () => {
    await openForm();
    submit();
    expect(text()).toContain("tienes que aceptar");
    consentBox().checked = true;
    emailField().value = "not-an-email";
    submit();
    expect(text()).toContain("Escribe el correo");
    emailField().value = "rider@example.test";
    submit();
    expect(text()).toContain("Espera a que termine la comprobación");
    expect(passRequests()).toBe(0);
  });

  it("with a pass, goes to the login with the email as login_hint, and keeps the email nowhere", async () => {
    await openForm();
    fill(" Rider@Example.test ");
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.passes).toEqual([{ email: "rider@example.test", turnstile: "synthetic-result-0001" }]);
    const url = new URL(navigations[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://login.example.test/oauth2/authorize");
    expect(url.searchParams.get("login_hint")).toBe("rider@example.test");
    // The rest of the authorization request is the usual one.
    expect(url.searchParams.get("scope")).toBe("openid https://api.example.test/mcp/use");
    // Nothing of the email in the browser: not in storage, not in the address.
    expect([...store.values(), ...storageForTab.items.values()].join(" ")).not.toContain("rider@");
    expect(location.href).not.toContain("rider");
  });

  it.each([
    [403, '{"error": "control_no_valido"}', "La comprobación anti-robots no es válida o ya se ha usado."],
    [429, '{"error": "demasiados_pases"}', "demasiados accesos desde esta conexión"],
    [400, '{"error": "peticion_invalida"}', "El servicio no acepta este correo."],
    [503, '{"error": "no_disponible"}', "El servicio no responde ahora mismo."],
    [503, '{"estado": "pausa"}', "Estamos haciendo mantenimiento; vuelve más tarde."],
    [503, '{"estado": "cerrado"}', "Ahora mismo no se admiten entradas."],
  ])("refused with HTTP %i %s: says why, does not leave and starts a fresh check", async (status, body, message) => {
    await openForm();
    server.passOverride = { status, body };
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain(message));
    expect(navigations).toEqual([]);
    expect(widgets[0]?.resets).toBe(1);
    // The used result is not sent again.
    submit();
    expect(text()).toContain("Espera a que termine la comprobación");
    expect(passRequests()).toBe(1);
  });

  it("says so when the check cannot load or fails, and sends nothing", async () => {
    challengeFails = true;
    await start(PUBLIC);
    button("Entrar").click();
    await vi.waitFor(() => expect(text()).toContain("No se ha podido hacer la comprobación anti-robots."));
    expect(passRequests()).toBe(0);
  });

  it("drops an expired result", async () => {
    await openForm();
    fill();
    widgets[0]?.callbacks.onExpired();
    submit();
    expect(text()).toContain("Espera a que termine la comprobación");
    expect(passRequests()).toBe(0);
  });

  it("«Volver» goes back to the landing and takes the check down; a late /estado draws nothing", async () => {
    await openForm();
    button("Volver").click();
    expect(widgets[0]?.removed).toBe(true);
    expect(visibleButtons()).toContain("Entrar");
    // Hold /estado, leave, then let it answer: nothing of the screen comes back.
    let release: () => void = () => undefined;
    holdStatus = new Promise<void>((resolve) => (release = resolve));
    button("Entrar").click();
    await vi.waitFor(() => expect(text()).toContain("Comprobando si se puede entrar…"));
    button("Volver").click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(form()).toBeNull();
    expect(widgets).toHaveLength(1);
    expect(visibleButtons()).toContain("Entrar");
  });
});

describe("leaving the account", () => {
  it("«Salir» calls cerrar_sesion with the token, then goes to the login's sign-out page", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Salir"));
    expect(visibleButtons()).toContain("Borrar mis datos");
    button("Salir").click();
    // The data left the page at once.
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.accountCalls).toEqual([{ name: "cerrar_sesion", arguments: {} }]);
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("if cerrar_sesion fails, forgets the token here, stays on the page and says the session ends by itself", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Salir"));
    server.accountFailure = "logout_failed";
    button("Salir").click();
    await vi.waitFor(() => expect(text()).toContain("Se borrará sola en menos de una hora."));
    expect(text()).toContain("logout_failed");
    expect(navigations).toEqual([]);
    expect(visibleButtons()).toContain("Entrar");
  });

  it("«Borrar mis datos» asks first; «Cancelar» keeps everything; confirming sends confirmar=true and signs out", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    button("Borrar mis datos").click();
    expect(text()).toContain("¿Borrar tus datos de este servicio?");
    button("Cancelar").click();
    expect(text()).not.toContain("¿Borrar tus datos de este servicio?");
    expect(server.accountCalls).toEqual([]);
    button("Borrar mis datos").click();
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos");
    confirm?.click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.accountCalls).toEqual([{ name: "borrar_mis_datos", arguments: { confirmar: true } }]);
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("if borrar_mis_datos fails, says so with its code and asks to sign in and repeat", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    server.accountFailure = "delete_failed";
    button("Borrar mis datos").click();
    [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos")?.click();
    await vi.waitFor(() => expect(text()).toContain("No se han podido borrar tus datos (código: delete_failed)."));
    expect(navigations).toEqual([]);
  });

  it("a paused service mid-session shows the maintenance text with «Reintentar»", async () => {
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "service_paused: x" }], isError: true } }),
    });
    await signedIn();
    await vi.waitFor(() => expect(text()).toContain("Estamos haciendo mantenimiento; vuelve más tarde."));
    expect(visibleButtons()).toContain("Reintentar");
  });

  it("an expired session offers «Volver a entrar», which opens the screen before the login", async () => {
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "session_expired: x" }], isError: true } }),
    });
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Volver a entrar"));
    server.mcpOverride = null;
    button("Volver a entrar").click();
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(navigations).toEqual([]);
  });
});

describe("the invitation build stays as it was", () => {
  it("«Entrar» goes straight to the login: no /estado, no check, no login_hint, no «Borrar mis datos»", async () => {
    await start(INVITATION);
    expect(text()).toContain("cada persona invitada");
    expect(visibleButtons()).not.toContain("Borrar mis datos");
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").searchParams.has("login_hint")).toBe(false);
    expect(server.requests).toHaveLength(0);
    expect(widgets).toHaveLength(0);
  });
});

describe("the real Turnstile loader", () => {
  it("loads Cloudflare's script once, with explicit rendering, and renders with the action the service checks", async () => {
    document.head.replaceChildren();
    const rendered: Record<string, unknown>[] = [];
    const host = document.createElement("div");
    const results: string[] = [];
    const pending = renderTurnstile(host, "0x4AAAAAAASyntheticKey", { onResult: (value) => results.push(value), onExpired: () => undefined, onError: () => undefined });
    const scripts = [...document.head.querySelectorAll("script")];
    expect(scripts.map((one) => one.src)).toEqual([TURNSTILE_SCRIPT]);
    expect(TURNSTILE_SCRIPT).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    Object.assign(globalThis, {
      turnstile: {
        render: (_host: HTMLElement, options: Record<string, unknown>) => (rendered.push(options), "widget-1"),
        reset: () => undefined,
        remove: () => undefined,
      },
    });
    scripts[0]?.dispatchEvent(new Event("load"));
    await pending;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ sitekey: "0x4AAAAAAASyntheticKey", action: TURNSTILE_ACTION, "response-field": false });
    expect(TURNSTILE_ACTION).toBe("web-pass");
    (rendered[0]?.["callback"] as (value: unknown) => void)("synthetic-result");
    expect(results).toEqual(["synthetic-result"]);
    // A second widget reuses the loaded script.
    await renderTurnstile(host, "0x4AAAAAAASyntheticKey", { onResult: () => undefined, onExpired: () => undefined, onError: () => undefined });
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
    delete (globalThis as { turnstile?: unknown }).turnstile;
  });
});

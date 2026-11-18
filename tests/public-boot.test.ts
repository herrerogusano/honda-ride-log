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
import { renderTurnstile, SCRIPT_TIMEOUT_MS, TURNSTILE_ACTION, TURNSTILE_SCRIPT } from "../src/access/turnstile";
import { createTracker, type Tracker } from "../src/analytics/tracker";
import { boot, DELETE_UNCONFIRMED, ENTER_FRAGMENT } from "../src/boot";
import { writeConsent } from "../src/storage/consent";
import type { ServiceConfig, ServiceEnvironment } from "../src/service/environment";
import type { App } from "../src/ui/app";
import { createMapView } from "../src/ui/mapView";
import { createTraceStore, type TraceStore } from "../src/ui/traceStore";
import type { RouteRef } from "../src/domain/model";
import { PRIVACY_NOTICE_VERSION } from "../src/ui/passScreen";
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
    createTraces: (caller) => {
      const store = createTraceStore(caller);
      const entry = { store, asked: [] as RouteRef[] };
      stores.push(entry);
      return { ...store, get: (route) => (entry.asked.push(route.ref), store.get(route)) };
    },
    mcp: { fetch: server.fetch, now: () => server.clock.now, sleep: async () => undefined, minIntervalMs: 0 },
    ...(counters === null ? {} : { analytics: counters }),
    reload: () => void reloads.push(location.href),
  });
  return mounted;
}

/** Every store of whole traces the page made, with the routes it was asked for. */
let stores: { store: TraceStore; asked: RouteRef[] }[] = [];
/** The routes whose whole trace some store still holds. */
const held = (): RouteRef[] => stores.flatMap(({ store, asked }) => asked.filter((ref) => store.known(ref) !== undefined));
/** Opens the first route of the list and waits until its whole trace is kept in memory. */
async function holdATrace(): Promise<void> {
  await vi.waitFor(() => expect(root.querySelector(".routes-table tbody tr .row-button")).not.toBeNull());
  root.querySelector<HTMLButtonElement>(".routes-table tbody tr .row-button")?.click();
  await vi.waitFor(() => expect(held()).toHaveLength(1));
}

/** The visit counters of the page under test, if any (synthetic identifiers), and the reloads it asked for. */
let counters: Tracker | null = null;
let reloads: string[] = [];
let listening = new AbortController();
const SYNTHETIC_COUNTERS = { cloudflareToken: "0123456789abcdef0123456789abcdef", googleMeasurementId: "G-TEST1234" } as const;
const GOOGLE_ONLY = { cloudflareToken: null, googleMeasurementId: "G-TEST1234" } as const;
const counterScripts = (): string[] => [...document.head.querySelectorAll("script")].map((one) => one.src);
const dataLayer = (): unknown => (window as unknown as { dataLayer?: unknown }).dataLayer;

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
  stores = [];
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
  counters = null;
  reloads = [];
  listening.abort();
  listening = new AbortController();
  document.head.replaceChildren();
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
  Reflect.deleteProperty(window, "ga-disable-G-TEST1234");
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
    expect(text()).toContain("Correo de tu cuenta de MAPIT");
    expect(emailField().getAttribute("autocomplete")).toBe("email");
    await vi.waitFor(() => expect(widgets).toHaveLength(1));
    expect(widgets[0]?.siteKey).toBe("0x4AAAAAAASyntheticKey");
    expect(navigations).toEqual([]);
  });

  it.each([
    ["cerrado", "Ahora mismo no se puede entrar. Prueba más adelante."],
    ["pausa", "El servicio está en pausa. Vuelve más tarde."],
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
    expect(text()).toContain("No quedan plazas para personas nuevas. Si ya has entrado antes, puedes seguir haciéndolo. Si no, puedes ver la demo.");
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
    expect(text()).toContain("Comprobando que no eres un robot…");
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
    // The managed login shows its own texts in Spanish (open service only).
    expect(url.searchParams.get("lang")).toBe("es");
    // The rest of the authorization request is the usual one.
    expect(url.searchParams.get("scope")).toBe("openid https://api.example.test/mcp/use");
    // Nothing of the email in the browser: not in storage, not in the address.
    expect([...store.values(), ...storageForTab.items.values()].join(" ")).not.toContain("rider@");
    expect(location.href).not.toContain("rider");
  });

  it.each([
    [403, '{"error": "control_no_valido"}', "La comprobación anti-robots no es válida o ha caducado. Pulsa «Continuar» otra vez; si se repite, recarga la página."],
    [429, '{"error": "demasiados_pases"}', "Demasiados intentos desde esta conexión. Espera unos 10 minutos."],
    [400, '{"error": "peticion_invalida"}', "El servicio no acepta este correo."],
    [503, '{"error": "no_disponible"}', "El servicio no responde ahora mismo."],
    [503, '{"estado": "pausa"}', "El servicio está en pausa. Vuelve más tarde."],
    [503, '{"estado": "cerrado"}', "Ahora mismo no se puede entrar. Prueba más adelante."],
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
    expect(text()).toContain("Comprobando que no eres un robot…");
    expect(passRequests()).toBe(1);
  });

  it("is one short view: one email field, a short consent with the full privacy text folded, nothing else to type", async () => {
    await openForm();
    expect(root.querySelectorAll("input")).toHaveLength(2);
    expect(root.querySelectorAll('input[type="email"]')).toHaveLength(1);
    const label = root.querySelector(`label[for="${consentBox().id}"]`);
    expect(label?.textContent?.trim()).toBe("Acepto el aviso de privacidad.");
    const privacy = root.querySelector("details");
    expect(privacy).not.toBeNull();
    expect(privacy?.open).toBe(false);
    expect(privacy?.querySelector("summary")?.textContent).toBe("Leer el aviso de privacidad");
    // The approved notice, whole and in order, then the contact line with its link.
    const paragraphs = [...(privacy?.querySelectorAll("p") ?? [])].map((one) => one.textContent);
    expect(paragraphs).toEqual([
      // Written out here, not imported: every period and promise is pinned by the test.
      "Esta web no es de Honda ni de MAPIT. Usarla con tu cuenta es decisión tuya: MAPIT podría bloquear o cancelar cuentas según sus condiciones. Tu correo y tu contraseña se escriben en la página de acceso del servicio (en AWS, Irlanda). La primera vez se comprueban con MAPIT; mientras estás dentro, la página de acceso guarda tu contraseña protegida y la borra con tu usuario. Esta web no ve la contraseña.",
      "Mientras estás dentro, el servicio guarda tu sesión de MAPIT cifrada y tu usuario de acceso. Se borran al salir y, si no sales, solos antes de una hora. Para contar plazas guarda una huella de tu correo (no el correo), con las fechas y el número de entradas. Caduca un año después de tu última entrada y se borra en los días siguientes, o al momento con «Borrar mis datos».",
      "Si MAPIT rechaza tu contraseña, se cuentan los intentos con esa huella durante 24 horas. Para frenar abusos se cuentan también, durante unos minutos, los pases pedidos desde tu conexión, con una huella de esa conexión. Los dos recuentos caducan solos y se borran en los días siguientes; «Borrar mis datos» no los borra.",
      "Solo se leen tus datos de MAPIT; nunca se cambian. Tu correo solo se guarda con tu usuario de acceso, mientras estás dentro. Las cifras de uso del servicio son totales, sin correos. Antes de entrar, Cloudflare comprueba que no eres un robot.",
      "Para cualquier petición sobre tus datos, abre una incidencia en github.com/herrerogusano/honda-ride-log/issues. Es pública: no escribas en ella tu correo ni datos de tu cuenta.",
    ]);
    const link = privacy?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/herrerogusano/honda-ride-log/issues");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(PRIVACY_NOTICE_VERSION).toBe("web-1");
    // Nothing on the screen says provisional any more.
    expect(text().toLowerCase()).not.toContain("provisional");
  });

  it("right under the email, one help line (same email, 3 attempts); the button says what is typed on the login page", async () => {
    await openForm();
    const leads = [...root.querySelectorAll(".pass-field ~ .pass-lead")].map((one) => one.textContent);
    expect(leads).toEqual([
      "En la página de acceso usa este mismo correo (si lo cambias, empieza otra vez aquí). Tienes 3 intentos de contraseña; después vuelve aquí. Esta web no ve tu contraseña.",
    ]);
    expect(root.querySelector(".pass-field")?.nextElementSibling?.textContent).toBe(leads[0]);
    const go = root.querySelector<HTMLButtonElement>('form button[type="submit"]');
    expect(go?.textContent).toBe("Continuar: escribe tu correo y contraseña de MAPIT");
    expect(go?.classList.contains("pass-continue")).toBe(true);
    // The button already says "contraseña de MAPIT": the help line does not repeat it.
    expect(leads.join(" ")).not.toMatch(/es la de MAPIT|en el paso siguiente/);
  });

  it("pressed before the check finishes, says it is checking and sends the pass by itself when the result arrives, once", async () => {
    await openForm();
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    expect(text()).toContain("Comprobando que no eres un robot…");
    expect(passRequests()).toBe(0);
    widgets[0]?.callbacks.onResult("synthetic-result-0002");
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.passes).toEqual([{ email: "rider@example.test", turnstile: "synthetic-result-0002" }]);
  });

  it("after a refused pass, a new result is only kept: sending again needs «Continuar»", async () => {
    await openForm();
    server.passOverride = { status: 403, body: '{"error": "control_no_valido"}' };
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    widgets[0]?.callbacks.onResult("synthetic-result-0005");
    await vi.waitFor(() => expect(text()).toContain("La comprobación anti-robots no es válida o ha caducado."));
    widgets[0]?.callbacks.onResult("synthetic-result-0006");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(1);
  });

  it("«Volver» while waiting for the check: a late result of that form sends nothing", async () => {
    await openForm();
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    expect(text()).toContain("Comprobando que no eres un robot…");
    const old = widgets[0];
    button("Volver").click();
    old?.callbacks.onResult("synthetic-result-late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(0);
    expect(navigations).toEqual([]);
  });

  it("restored from cache while waiting for the check: a late result of the old form sends nothing", async () => {
    await openForm();
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    const old = widgets[0];
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(widgets).toHaveLength(2));
    old?.callbacks.onResult("synthetic-result-late");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(0);
    expect(navigations).toEqual([]);
  });

  it.each([
    ["editing the email", () => {
      emailField().value = "other@example.test";
      emailField().dispatchEvent(new Event("input"));
    }],
    ["unticking the consent", () => {
      consentBox().checked = false;
      consentBox().dispatchEvent(new Event("change"));
    }],
  ])("%s while waiting for the check cancels the wait: the result alone sends nothing", async (_label, change) => {
    await openForm();
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    expect(text()).toContain("Comprobando que no eres un robot…");
    change();
    expect(text()).not.toContain("Comprobando que no eres un robot…");
    widgets[0]?.callbacks.onResult("synthetic-result-0007");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(0);
    // A new press sends what is on screen now.
    consentBox().checked = true;
    submit();
    await vi.waitFor(() => expect(passRequests()).toBe(1));
  });

  it("does not send by itself after a failed check, nor without being asked", async () => {
    await openForm();
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    // A result that arrives with nobody waiting is only kept.
    widgets[0]?.callbacks.onResult("synthetic-result-0003");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(0);
    widgets[0]?.callbacks.onExpired();
    submit();
    widgets[0]?.callbacks.onError();
    expect(text()).toContain("No se ha podido hacer la comprobación anti-robots.");
    widgets[0]?.callbacks.onResult("synthetic-result-0004");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(passRequests()).toBe(0);
  });

  it("sends one pass however many times the form is submitted while it waits", async () => {
    await openForm();
    fill();
    let release: () => void = () => undefined;
    server.passOverride = null;
    const held = new Promise<void>((resolve) => (release = resolve));
    const original = server.fetch;
    Object.assign(server, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/pase")) await held;
        return original(input, init);
      },
    });
    submit();
    submit();
    submit();
    release();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(passRequests()).toBe(1);
  });

  it("with the pass issued, wipes the email, the result and the check before leaving", async () => {
    await openForm();
    fill("rider@example.test");
    const field = emailField();
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(field.value).toBe("");
    expect(form()).toBeNull();
    expect(root.querySelector('input[type="email"]')).toBeNull();
    expect(widgets[0]?.removed).toBe(true);
    expect(text()).toContain("Abriendo el login…");
    expect(new XMLSerializer().serializeToString(root)).not.toContain("rider@");
  });

  it("restored from the browser's cache («Atrás» from the login), starts over: a fresh status, form and check", async () => {
    await openForm();
    fill();
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const statusReads = (): number => server.requests.filter((one) => one.url === CONFIG.publicAccess?.statusUrl).length;
    expect(statusReads()).toBe(1);
    // A normal page show does nothing.
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    expect(form()).toBeNull();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(statusReads()).toBe(2);
    await vi.waitFor(() => expect(widgets).toHaveLength(2));
    expect(emailField().value).toBe("");
    expect(consentBox().checked).toBe(false);
    // The old result is gone: nothing is sent without a new check.
    consentBox().checked = true;
    emailField().value = "rider@example.test";
    submit();
    expect(text()).toContain("Comprobando que no eres un robot…");
    expect(passRequests()).toBe(1);
  });

  it("a status answer from before a restore from cache draws nothing: one form, one check", async () => {
    await start(PUBLIC);
    let release: () => void = () => undefined;
    holdStatus = new Promise<void>((resolve) => (release = resolve));
    button("Entrar").click();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    release();
    await vi.waitFor(() => expect(form()).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelectorAll("form")).toHaveLength(1);
    expect(widgets).toHaveLength(1);
  });

  it("stops listening for page shows once the screen is gone", async () => {
    await openForm();
    button("Volver").click();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(form()).toBeNull();
    expect(server.requests.filter((one) => one.url === CONFIG.publicAccess?.statusUrl)).toHaveLength(1);
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
    expect(text()).toContain("Comprobando que no eres un robot…");
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
  it("keeps only «Salir» in the bar and puts «Borrar mis datos» at the end of the footer's «Privacidad»", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    const bar = root.querySelector("header.topbar") as HTMLElement;
    expect([...bar.querySelectorAll(".bar-end button")].map((one) => one.textContent)).toEqual(["Salir"]);
    expect([...bar.querySelectorAll("button")].map((one) => one.textContent)).not.toContain("Borrar mis datos");
    expect(bar.querySelector(".bar-end > .sign-out")).not.toBeNull();
    expect(root.querySelector(".bar-account")).toBeNull();
    const privacy = root.querySelector(".site-foot .foot-privacy") as HTMLElement;
    expect(privacy.querySelector("h2")?.textContent).toBe("Privacidad");
    const line = privacy.lastElementChild as HTMLElement;
    expect(line.textContent).toBe("Puedes borrar al momento tus datos de este servicio: Borrar mis datos.");
    // A real button (reached with the tab key), styled as a link.
    const remove = line.querySelector("button") as HTMLButtonElement;
    expect([remove.textContent, remove.type, remove.className]).toEqual(["Borrar mis datos", "button", "link-button delete-data"]);
    expect(root.querySelectorAll(".delete-data")).toHaveLength(1);
  });

  it("shows no «Borrar mis datos» with the demo on screen", async () => {
    await start(PUBLIC, "/#demo");
    await vi.waitFor(() => expect(root.querySelector(".site-foot .foot-privacy")).not.toBeNull());
    expect(root.querySelector(".delete-data")).toBeNull();
    expect(visibleButtons()).not.toContain("Borrar mis datos");
  });

  it("«Salir» calls cerrar_sesion with the token, then goes to the login's sign-out page", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    button("Salir").click();
    // The data left the page at once.
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.accountCalls).toEqual([{ name: "cerrar_sesion", arguments: {} }]);
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("even if cerrar_sesion fails, or the session had already ended, goes to the login's sign-out page", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Salir"));
    server.accountFailure = "logout_failed";
    button("Salir").click();
    // The login's own session must not outlive a sign-out (a shared device).
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
    expect(server.accountCalls).toEqual([{ name: "cerrar_sesion", arguments: {} }]);
  });

  it("with the session already over, «Salir» sends nothing and still goes to the login's sign-out page", async () => {
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "session_expired: x" }], isError: true } }),
    });
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Volver a entrar"));
    button("Salir").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
    expect(server.accountCalls).toEqual([]);
  });

  it("«Borrar mis datos» asks first; «Cancelar» keeps everything; confirming sends confirmar=true and signs out", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    button("Borrar mis datos").click();
    expect(text()).toContain("¿Borrar tus datos de este servicio?");
    // The question opens right under the footer's button, focused on its first answer.
    const panel = root.querySelector(".delete-confirm") as HTMLElement;
    expect(panel.previousElementSibling?.classList.contains("foot-delete")).toBe(true);
    expect(panel.getAttribute("role")).toBe("alertdialog");
    expect(document.activeElement).toBe(panel.querySelector("button"));
    // What stays: the failed-attempts count, which deletes itself.
    expect(text()).toContain("Tus datos en MAPIT no se modifican. El recuento de intentos fallidos caduca a las 24 horas y se borra en los días siguientes. Después se cierra la sesión.");
    button("Cancelar").click();
    expect(text()).not.toContain("¿Borrar tus datos de este servicio?");
    expect(server.accountCalls).toEqual([]);
    // «Cancelar» gives the focus back to the footer's button.
    expect(document.activeElement?.closest(".foot-delete")).not.toBeNull();
    button("Borrar mis datos").click();
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos");
    confirm?.click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.accountCalls).toEqual([{ name: "borrar_mis_datos", arguments: { confirmar: true } }]);
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("if borrar_mis_datos fails, still goes to the login's sign-out page, and back on the page says the delete was not confirmed, once", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    server.accountFailure = "delete_failed";
    button("Borrar mis datos").click();
    [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos")?.click();
    // The login's own session ends too, whatever the tool said.
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
    expect(server.accountCalls).toEqual([{ name: "borrar_mis_datos", arguments: { confirmar: true } }]);
    // Back from the sign-out page: a new page load.
    mounted?.dispose();
    await start(PUBLIC);
    expect(text()).toContain(DELETE_UNCONFIRMED);
    expect(DELETE_UNCONFIRMED).toBe("No hemos podido confirmar que tus datos se hayan borrado. Tu sesión está cerrada. Entra otra vez y repite «Borrar mis datos».");
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(DELETE_UNCONFIRMED);
    expect(visibleButtons()).toContain("Entrar");
    // Said once: a reload does not repeat it.
    mounted?.dispose();
    await start(PUBLIC);
    expect(text()).not.toContain(DELETE_UNCONFIRMED);
  });

  it("a delete that succeeds leaves no notice behind", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    button("Borrar mis datos").click();
    [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos")?.click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    mounted?.dispose();
    await start(PUBLIC);
    expect(text()).not.toContain(DELETE_UNCONFIRMED);
    expect(storageForTab.items.size).toBe(0);
  });

  it.each(["session_limit_reached", "session_expired"])("a route trace refused with %s offers «Volver a entrar» in the map, never «Reintentar»", async (code) => {
    server.mcpOverride = (request) => {
      const message = JSON.parse(request.body) as { id: number; params: { name: string } };
      if (message.params.name !== "get_route_detail") return null;
      return { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${code}: x` }], isError: true } }) };
    };
    await signedIn();
    await vi.waitFor(() => expect(root.querySelector(".routes-table tbody tr .row-button")).not.toBeNull());
    root.querySelector<HTMLButtonElement>(".routes-table tbody tr .row-button")?.click();
    const panel = await vi.waitFor(() => {
      const found = root.querySelector<HTMLElement>(".archive-map .error");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect([...panel.querySelectorAll("button")].map((one) => one.textContent)).toEqual(["Volver a entrar"]);
  });

  it("«Borrar mis datos» drops the whole traces kept in memory before anything is sent", async () => {
    await signedIn();
    await holdATrace();
    button("Borrar mis datos").click();
    const confirm = [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos");
    confirm?.click();
    expect(held()).toEqual([]);
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(held()).toEqual([]);
  });

  it("session_expired from the service drops the whole traces kept in memory", async () => {
    await signedIn();
    await holdATrace();
    server.mcpOverride = sdkToolError("session_expired");
    root.querySelectorAll<HTMLButtonElement>(".routes-table tbody tr .row-button")[1]?.click();
    await vi.waitFor(() => expect(root.querySelector(".archive-map .error")).not.toBeNull());
    expect(held()).toEqual([]);
  });

  it("a paused service mid-session shows the maintenance text with «Reintentar»", async () => {
    server.mcpOverride = (request) => ({
      body: JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(request.body) as { id: number }).id, result: { content: [{ type: "text", text: "service_paused: x" }], isError: true } }),
    });
    await signedIn();
    await vi.waitFor(() => expect(text()).toContain("El servicio está en pausa. Vuelve más tarde."));
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

  /** The service's answer as the MCP Python SDK words a tool error. */
  const sdkToolError = (code: string) => (request: { body: string }) => {
    const message = JSON.parse(request.body) as { id: number; params: { name: string } };
    const text = `Error executing tool ${message.params.name}: ${code}: MAPIT did not answer in time`;
    return { body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: true } }) };
  };

  it("with the SDK's real text, session_expired ends the session: «Volver a entrar», and «Salir» sends nothing with the old token", async () => {
    server.mcpOverride = sdkToolError("session_expired");
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Volver a entrar"));
    expect(text()).toContain("Tu sesión ha terminado: dura menos de una hora y después se borra sola. Vuelve a entrar.");
    expect(text()).not.toMatch(/Error executing|MAPIT did not answer/);
    server.mcpOverride = null;
    button("Salir").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(server.accountCalls).toEqual([]);
    expect(new URL(navigations[0] ?? "").pathname).toBe("/logout");
  });

  it("no code or text of the service reaches the visit counters, even with no arrival address to go by", async () => {
    server.mcpOverride = sdkToolError("mapit_unavailable");
    await openForm();
    fill();
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    const back = new URL(server.approve(navigations[0] ?? ""));
    mounted?.dispose();
    // The page the login sends back to is a new page load, with a new counter. Even without
    // an arrival address (the worst case) it holds a token, so its counters never start.
    writeConsent("granted", server.clock.now);
    counters = createTracker(GOOGLE_ONLY, { arrival: () => null, signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC, back.pathname + back.search);
    await vi.waitFor(() => expect(text()).toContain("/tool_error (mapit_unavailable)"));
    expect(counterScripts()).toEqual([]);
    expect(dataLayer()).toBeUndefined();
  });

  it("a reload keeps the session: the account again with the same token, no screen before the login, no counter", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    const token = server.issuedTokens[0] ?? "";
    const before = server.requests.length;
    mounted?.dispose();
    writeConsent("granted", server.clock.now);
    counters = createTracker(SYNTHETIC_COUNTERS, { arrival: () => "http://localhost:3000/", signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC, "/");
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    const after = server.requests.slice(before);
    // No /estado, no pass, no login: only the account's tools, with the same token.
    expect(after.every((one) => one.url === CONFIG.mcpUrl)).toBe(true);
    for (const one of after) expect(one.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(navigations).toEqual([]);
    expect(widgets).toHaveLength(1);
    counters.grant();
    expect(counterScripts()).toEqual([]);
    expect(dataLayer()).toBeUndefined();
  });

  it("a reload at #entrar with a kept session loads the account, not the screen before the login", async () => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Salir"));
    mounted?.dispose();
    await start(PUBLIC, `/${ENTER_FRAGMENT}`);
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    expect(emailField()).toBeNull();
  });

  it.each([
    ["«Salir»", () => button("Salir").click()],
    ["«Borrar mis datos»", () => {
      button("Borrar mis datos").click();
      [...root.querySelectorAll<HTMLButtonElement>(".delete-confirm button")].find((one) => one.textContent === "Borrar mis datos")?.click();
    }],
  ])("%s forgets the token kept in the tab before leaving", async (_name, leave) => {
    await signedIn();
    await vi.waitFor(() => expect(visibleButtons()).toContain("Borrar mis datos"));
    // The token and the account data bound to it.
    expect(storageForTab.items.size).toBe(2);
    leave();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(storageForTab.items.size).toBe(0);
  });

  it("session_expired from the service forgets the token kept in the tab", async () => {
    await signedIn();
    await holdATrace();
    expect(storageForTab.items.size).toBe(2);
    server.mcpOverride = sdkToolError("session_expired");
    root.querySelectorAll<HTMLButtonElement>(".routes-table tbody tr .row-button")[1]?.click();
    await vi.waitFor(() => expect(root.querySelector(".archive-map .error")).not.toBeNull());
    expect(storageForTab.items.size).toBe(0);
  });
});

describe("no visit counter shares a page with the email (docs/PLAN.md, section 18)", () => {
  it("with a counter already in the page, «Entrar» reloads into the screen instead of drawing the form there", async () => {
    writeConsent("granted", server.clock.now);
    counters = createTracker(SYNTHETIC_COUNTERS, { arrival: () => null, signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC);
    expect(counterScripts()).toHaveLength(2);
    button("Entrar").click();
    expect(reloads).toEqual([`http://localhost:3000/${ENTER_FRAGMENT}`]);
    expect(emailField()).toBeNull();
    expect(text()).toContain("Abriendo la entrada…");
    expect(server.requests).toHaveLength(0);
    expect(widgets).toHaveLength(0);
    // Google, already in memory, stops sending.
    expect((window as unknown as Record<string, unknown>)["ga-disable-G-TEST1234"]).toBe(true);
  });

  it("the page loaded at #entrar opens the screen with no counter in it, whatever the answer to the cookies, through to the login", async () => {
    writeConsent("granted", server.clock.now);
    counters = createTracker(SYNTHETIC_COUNTERS, { arrival: () => `http://localhost:3000/${ENTER_FRAGMENT}`, signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC, `/${ENTER_FRAGMENT}`);
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(location.hash).toBe("");
    counters.grant();
    fill("rider@example.test");
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").searchParams.get("login_hint")).toBe("rider@example.test");
    expect(counterScripts().filter((src) => !src.startsWith("https://challenges.cloudflare.com"))).toEqual([]);
    expect(dataLayer()).toBeUndefined();
    expect(reloads).toEqual([]);
  });

  it("with no counter loaded yet, draws the form in place and keeps Google out even if the cookies are accepted meanwhile", async () => {
    counters = createTracker(GOOGLE_ONLY, { arrival: () => null, signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC);
    button("Entrar").click();
    await vi.waitFor(() => expect(form()).not.toBeNull());
    expect(reloads).toEqual([]);
    counters.grant();
    fill();
    submit();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(counterScripts()).toEqual([]);
    expect(dataLayer()).toBeUndefined();
  });

  it("«Volver» from the screen leaves the counters off for the rest of that page", async () => {
    counters = createTracker(GOOGLE_ONLY, { arrival: () => null, signal: listening.signal, now: () => server.clock.now });
    await start(PUBLIC);
    button("Entrar").click();
    await vi.waitFor(() => expect(form()).not.toBeNull());
    button("Volver").click();
    counters.grant();
    button("Ver la demo").click();
    expect(counterScripts()).toEqual([]);
    expect(dataLayer()).toBeUndefined();
  });

  it("an invitation build ignores #entrar: its counters start as always", async () => {
    writeConsent("granted", server.clock.now);
    counters = createTracker(GOOGLE_ONLY, { arrival: () => null, signal: listening.signal, now: () => server.clock.now });
    await start(INVITATION, `/${ENTER_FRAGMENT}`);
    expect(counterScripts()).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-TEST1234"]);
    expect(emailField()).toBeNull();
  });
});

describe("the invitation build stays as it was", () => {
  it("keeps «Salir» straight in the bar, with no account group", async () => {
    await start(INVITATION);
    expect(root.querySelector(".bar-account")).toBeNull();
    expect(root.querySelector(".bar-end > .sign-out")).not.toBeNull();
  });

  it("does not read or show the open service's notice", async () => {
    storageForTab.setItem("ride-log.leave-notice", JSON.stringify({ notice: "delete_unconfirmed", createdAt: server.clock.now }));
    await start(INVITATION);
    expect(text()).not.toContain(DELETE_UNCONFIRMED);
    expect(storageForTab.items.size).toBe(1);
  });

  it("«Entrar» goes straight to the login: no /estado, no check, no login_hint, no «Borrar mis datos»", async () => {
    await start(INVITATION);
    expect(text()).toContain("cada persona invitada");
    expect(visibleButtons()).not.toContain("Borrar mis datos");
    button("Entrar").click();
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
    expect(new URL(navigations[0] ?? "").searchParams.has("login_hint")).toBe(false);
    expect(new URL(navigations[0] ?? "").searchParams.has("lang")).toBe(false);
    expect(server.requests).toHaveLength(0);
    expect(widgets).toHaveLength(0);
  });
});

describe("the real Turnstile loader", () => {
  it("gives up on a script that never arrives, so the form can say so, and tries again next time", async () => {
    // First in this file to use the real loader: nothing is cached yet.
    document.head.replaceChildren();
    vi.useFakeTimers();
    try {
      const callbacks = { onResult: () => undefined, onExpired: () => undefined, onError: () => undefined };
      const pending = renderTurnstile(document.createElement("div"), "0x4AAAAAAASyntheticKey", callbacks).then(
        () => "rendered",
        (error: unknown) => (error as Error).message,
      );
      expect(document.head.querySelectorAll("script")).toHaveLength(1);
      vi.advanceTimersByTime(SCRIPT_TIMEOUT_MS);
      expect(await pending).toBe("turnstile_unavailable");
      // The late request is not repeated: the retry waits on the same element.
      const first = document.head.querySelector("script");
      const retry = renderTurnstile(document.createElement("div"), "0x4AAAAAAASyntheticKey", callbacks).then(
        () => "rendered",
        (error: unknown) => (error as Error).message,
      );
      expect([...document.head.querySelectorAll("script")]).toEqual([first]);
      vi.advanceTimersByTime(SCRIPT_TIMEOUT_MS);
      expect(await retry).toBe("turnstile_unavailable");
      // The script arrives late after all: the next try uses it, without a second request.
      Object.assign(globalThis, { turnstile: { render: () => "widget-late", reset: () => undefined, remove: () => undefined } });
      first?.dispatchEvent(new Event("load"));
      expect(await renderTurnstile(document.createElement("div"), "0x4AAAAAAASyntheticKey", callbacks).then(() => "rendered")).toBe("rendered");
      expect(document.head.querySelectorAll("script")).toHaveLength(1);
      delete (globalThis as { turnstile?: unknown }).turnstile;
    } finally {
      vi.useRealTimers();
    }
  });

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
    expect(rendered[0]).toMatchObject({ sitekey: "0x4AAAAAAASyntheticKey", action: TURNSTILE_ACTION, "response-field": false, appearance: "interaction-only" });
    expect(TURNSTILE_ACTION).toBe("web-pass");
    (rendered[0]?.["callback"] as (value: unknown) => void)("synthetic-result");
    expect(results).toEqual(["synthetic-result"]);
    // A second widget reuses the loaded script.
    await renderTurnstile(host, "0x4AAAAAAASyntheticKey", { onResult: () => undefined, onExpired: () => undefined, onError: () => undefined });
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
    delete (globalThis as { turnstile?: unknown }).turnstile;
  });
});

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { DEMO_SEED } from "../src/demo/scenarios";
import type { Route } from "../src/domain/model";
import type { ToolCaller, ToolName } from "../src/service/contract";
import { startApp, type App } from "../src/ui/app";
import { cardContent, CARD_SIZE, drawCard } from "../src/ui/card";
import type { RiderData } from "../src/ui/data";
import { downloadBlob } from "../src/ui/download";
import type { MapView } from "../src/ui/mapView";
import { PAGE_SIZE, renderRoutes } from "../src/ui/routesView";
import { createTabs } from "../src/ui/tabs";
import { rides } from "./helpers";

/** Wiring of the page that an independent review found without a test. */
const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: DEMO_SEED, nowMs: NOW });

let root: HTMLElement;
const mapCalls: string[] = [];
let mounted: App | undefined;

function mount(hash = ""): App {
  // Only one app at a time listens to the address.
  mounted?.dispose();
  history.replaceState(null, "", hash === "" ? "/" : `/${hash}`);
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
  mapCalls.length = 0;
  const createMap = (): MapView => ({
    element: document.createElement("div"),
    open: () => void mapCalls.push("open"),
    shown: () => void mapCalls.push("shown"),
    destroy: () => void mapCalls.push("destroy"),
  });
  mounted = startApp({ root, now: () => NOW, demoDelayMs: 0, createMap });
  return mounted;
}

const text = (): string => document.body.textContent ?? "";
const tab = (name: string): HTMLButtonElement =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((one) => one.textContent === name) as HTMLButtonElement;
const loaded = (): Promise<void> => vi.waitFor(() => expect(root.querySelector('[role="tablist"]')).not.toBeNull());
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll("button")].find((one) => (one.textContent ?? "").includes(label)) as HTMLButtonElement;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A caller whose answers wait until the test lets each one go. */
function staged(): { caller: ToolCaller; calls: ToolName[]; release: (count?: number) => Promise<void>; releaseAll: () => void } {
  const service = createDemoService(rider);
  const calls: ToolName[] = [];
  const waiting: (() => void)[] = [];
  return {
    calls,
    caller: {
      async callTool(name, args) {
        calls.push(name);
        await new Promise<void>((resolve) => waiting.push(resolve));
        return service.callTool(name, args);
      },
    },
    async release(count = 1) {
      for (let i = 0; i < count; i += 1) {
        await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
        waiting.shift()?.();
        await tick();
      }
    },
    releaseAll() {
      for (const go of waiting.splice(0)) go();
    },
  };
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("a load that is replaced", () => {
  it("draws nothing and asks the service for nothing more, at whatever step it was", async () => {
    // 9 answers: the state, the vehicle and seven of the eight semesters; the last one is on its way.
    for (const answersBeforeLeaving of [0, 1, 2, 3, 9]) {
      const app = mount();
      const old = staged();
      const running = app.load(old.caller, { demo: false });
      await old.release(answersBeforeLeaving);
      app.showLanding();
      const callsWhenLeft = old.calls.length;
      // Let the abandoned load receive everything it was waiting for.
      await old.release(1);
      await tick();
      await running;
      expect(text(), `left after ${answersBeforeLeaving} answers`).toContain("Ver la demo");
      expect(text()).not.toContain("Batería");
      expect(text()).not.toContain("Cargando rutas");
      expect(root.querySelector('[role="tablist"]')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(old.calls.length, `left after ${answersBeforeLeaving} answers`).toBe(callsWhenLeft);
    }
  });

  it("does not show the error of a load nobody is waiting for", async () => {
    const app = mount();
    let fail: (error: Error) => void = () => undefined;
    const failing: ToolCaller = {
      callTool: () => new Promise((_resolve, reject) => (fail = reject)),
    };
    const running = app.load(failing, { demo: false });
    app.showLanding();
    fail(new Error("late"));
    await running;
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("Ver la demo");
  });
});

describe("progress of a load", () => {
  it("says which step it is on and shows the vehicle as soon as it is known", async () => {
    const app = mount();
    const steps = staged();
    const running = app.load(steps.caller, { demo: false });
    const status = (): string => root.querySelector('[role="status"]')?.textContent ?? "";
    expect(status()).toBe("Leyendo el estado de la moto…");
    expect(root.querySelector(".vehicle-line")).toBeNull();
    await steps.release();
    expect(status()).toBe("Leyendo los datos del vehículo…");
    const line = root.querySelector(".vehicle-line") as HTMLElement;
    expect(line.textContent).toBe(`Batería ${rider.status.battery} % · Odómetro ${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(rider.status.odometer as number)} km`);
    // The vehicle comes first on the page, the progress under it.
    expect(line.compareDocumentPosition(root.querySelector('[role="status"]') as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await steps.release();
    expect(status()).toMatch(/^Cargando rutas de 2026… 0 hasta ahora\.$/);
    await steps.release();
    expect(status()).toMatch(/^Cargando rutas de 2026… [1-9]\d* hasta ahora\.$/);
    let finished = false;
    void running.then(() => (finished = true)); while (!finished) { steps.releaseAll(); await tick(); }
    expect(root.querySelector(".loading")).toBeNull();
    expect(root.querySelector(".vehicle-line")).toBeNull();
  });

  it("removes the progress line and keeps the vehicle when the routes fail", async () => {
    mount("#demo=error");
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.querySelector(".loading")).toBeNull();
    expect(root.querySelector(".vehicle-line")?.textContent).toContain("Batería");
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows only the error when the vehicle state fails", async () => {
    const app = mount();
    await app.load({ callTool: () => Promise.reject(new Error("x")) }, { demo: false });
    const content = root.querySelector(".content") as HTMLElement;
    expect(content.children.length).toBe(1);
    expect(content.firstElementChild?.getAttribute("role")).toBe("alert");
    expect(content.querySelector("code")?.textContent).toBe("status/unknown (Error)");
  });
});

describe("demo controls", () => {
  it("changes the scenario from the selector without losing the keyboard focus", async () => {
    mount("#demo");
    await loaded();
    const select = root.querySelector<HTMLSelectElement>(".demo-banner select") as HTMLSelectElement;
    expect(select.value).toBe("commuter");
    select.focus();
    select.value = "empty";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(text()).toContain("Todavía no hay rutas"));
    expect(location.hash).toBe("#demo=empty");
    expect(root.querySelector(".demo-banner select")).toBe(select);
    expect(document.activeElement).toBe(select);
    const label = root.querySelector(".demo-banner label") as HTMLLabelElement;
    expect(label.getAttribute("for")).toBe(select.id);
  });

  it("follows the address when it changes on an open page", async () => {
    mount("#demo");
    await loaded();
    location.hash = "#demo=empty";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(text()).toContain("Todavía no hay rutas"));
    expect(root.querySelector<HTMLSelectElement>(".demo-banner select")?.value).toBe("empty");
  });

  it("stops following the address once it is disposed of", async () => {
    const app = mount();
    app.dispose();
    history.replaceState(null, "", "/#demo");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(root.querySelector(".tabs")).toBeNull();
    expect(root.querySelector(".loading")).toBeNull();
    expect(text()).toContain("Ver la demo");
  });

  it("does not start again when the address names the scenario already on screen", async () => {
    mount("#demo=heavy");
    await loaded();
    const view = root.querySelector(".tabs");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(root.querySelector(".tabs")).toBe(view);
    expect(root.querySelector(".loading")).toBeNull();
  });

  it("leaves the demo when the address stops asking for it, and comes back when it asks again", async () => {
    mount("#demo");
    await loaded();
    history.replaceState(null, "", "/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(root.querySelector(".tabs")).toBeNull();
    expect(text()).toContain("Ver la demo");
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
    // Nothing happens on the landing page while the address asks for nothing.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(text()).toContain("Ver la demo");
    history.replaceState(null, "", "/#demo");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await loaded();
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(false);
  });

  it("never replaces the view of a real account with the demo because of the address", async () => {
    const app = mount();
    await app.load(createDemoService(rider), { demo: false });
    const view = root.querySelector(".tabs");
    expect(view).not.toBeNull();
    history.replaceState(null, "", "/#demo=empty");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await tick();
    expect(root.querySelector(".tabs")).toBe(view);
    // And the request for the demo does not stay in the address, where a reload would obey it.
    expect(location.hash).toBe("");
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
    history.replaceState(null, "", "/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(root.querySelector(".tabs")).toBe(view);
    // Back on the landing page, the address works again.
    app.showLanding();
    history.replaceState(null, "", "/#demo=empty");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(text()).toContain("Todavía no hay rutas"));
  });

  it("moves the focus to what replaced the button that was pressed", async () => {
    mount();
    button("Ver la demo").click();
    expect(document.activeElement).toBe(root.querySelector(".content"));
    await loaded();
    button("Salir de la demo").click();
    expect(document.activeElement).toBe(button("Ver la demo"));
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps the demo mark when a failed demo load is retried", async () => {
    mount("#demo=error");
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    button("Reintentar").click();
    expect(document.activeElement).toBe(root.querySelector(".content"));
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(false);
    expect(location.hash).toBe("#demo=error");
  });

  it("leaves nothing of the demo on screen or in the address for a real account", async () => {
    const app = mount("#demo");
    await loaded();
    await app.load(createDemoService(rider), { demo: false });
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
    expect(location.hash).toBe("");
    expect(text().includes("(datos de ejemplo)")).toBe(false);
  });
});

describe("tabs and the map", () => {
  it("tells the map when its tab is shown, and opens a route there with the focus on the tab", async () => {
    mount("#demo");
    await loaded();
    expect(mapCalls).toEqual([]);
    tab("Mapa").click();
    expect(mapCalls).toEqual(["shown"]);
    tab("Rutas").click();
    expect(mapCalls).toEqual(["shown"]);
    root.querySelector<HTMLButtonElement>(".row-button")?.click();
    expect(mapCalls).toEqual(["shown", "shown", "open"]);
    expect(document.activeElement).toBe(tab("Mapa"));
    // Leaving the view releases its map; so does replacing it with another load.
    button("Salir de la demo").click();
    expect(mapCalls).toEqual(["shown", "shown", "open", "destroy"]);
    // So does replacing the view with another load.
    mount("#demo");
    await loaded();
    tab("Mapa").click();
    const select = root.querySelector<HTMLSelectElement>(".demo-banner select") as HTMLSelectElement;
    select.value = "empty";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(mapCalls).toEqual(["shown", "destroy"]);
  });

  it("calls back once per change, keeps panels reachable and names the tab list", () => {
    const seen: string[] = [];
    const panels = [document.createElement("div"), document.createElement("div")] as [HTMLElement, HTMLElement];
    const tabs = createTabs("Secciones", [{ id: "a", label: "A", panel: panels[0] }, { id: "b", label: "B", panel: panels[1] }], (id) => seen.push(id));
    document.body.append(tabs.element);
    expect(seen).toEqual([]);
    expect(tabs.element.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Secciones");
    expect(panels.map((panel) => panel.tabIndex)).toEqual([0, 0]);
    tabs.select("b");
    tabs.select("b");
    tabs.select("missing");
    expect(seen).toEqual(["b"]);
    expect(tabs.selected()).toBe("b");
    const arrow = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    tabs.element.querySelectorAll('[role="tab"]')[1]?.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(seen).toEqual(["b", "a"]);
    const other = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    tabs.element.querySelector('[role="tab"]')?.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});

describe("Rutas, cell by cell", () => {
  const list = rides([
    { start: "2026-03-07T23:30:00-08:00", km: 8.26, minutes: 25, speed: 31.4 },
    { start: "2026-03-09T07:05:00-07:00", km: 120, minutes: 95, speed: null },
    { start: "2026-03-10T10:00:00-07:00", km: 3, minutes: null, speed: 12 },
  ]);
  const many = rides(Array.from({ length: 250 }, (_, index) => ({ start: new Date(Date.parse("2025-01-01T20:00:00Z") + index * 86_400_000).toISOString(), km: 1 + (index % 7) })));
  const data = (routes: readonly Route[]): RiderData => ({
    vehicle: { status: null, batteryPercent: null, lastCommunicationMs: null, odometer: null },
    info: null,
    routes,
    figures: routes,
    hiddenShort: 0,
    shortCounted: false,
    skipped: 0,
    demo: false,
    nowMs: NOW,
  });
  let view: HTMLElement;
  const show = (routes: readonly Route[], onOpen: (route: Route) => void = () => undefined): void => {
    view = renderRoutes(data(routes), onOpen);
    document.body.replaceChildren(view);
  };
  const rows = (): string[][] => [...view.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => (cell.textContent ?? "").replace(", ver en el mapa", "")));
  const count = (): string => view.querySelector(".count")?.textContent ?? "";
  const more = (): HTMLButtonElement => [...view.querySelectorAll("button")].find((one) => one.textContent === "Mostrar más rutas") as HTMLButtonElement;
  const search = (value: string): void => {
    const input = view.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const sort = (value: string): void => {
    const select = view.querySelector("select") as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("writes date, start, duration, km and speed of each route, newest first", () => {
    show(list);
    expect(rows()).toEqual([
      ["mar 10 mar 2026", "10:00", "—", "3,0", "12"],
      ["lun 9 mar 2026", "07:05", "1 h 35 min", "120,0", "—"],
      ["sáb 7 mar 2026", "23:30", "25 min", "8,3", "31"],
    ]);
    expect(count()).toBe("3 rutas.");
    expect(more().hidden).toBe(true);
    search("sabado");
    expect(count()).toBe("1 ruta.");
  });

  it("hands the pressed route to whoever opens it", () => {
    const opened: Route[] = [];
    show(list, (route) => opened.push(route));
    view.querySelectorAll<HTMLButtonElement>(".row-button")[1]?.click();
    expect(opened).toEqual([list[1]]);
  });

  it("goes back to the first page when the search or the order changes", () => {
    show(many);
    expect(rows().length).toBe(PAGE_SIZE);
    expect(more().hidden).toBe(false);
    more().click();
    expect(rows().length).toBe(2 * PAGE_SIZE);
    more().click();
    expect(rows().length).toBe(250);
    expect(more().hidden).toBe(true);
    expect(count()).toBe("250 rutas.");
    // Exactly one page of routes: nothing more to show.
    show(many.slice(0, PAGE_SIZE));
    expect(rows().length).toBe(PAGE_SIZE);
    expect(more().hidden).toBe(true);
    show(many);
    more().click();
    more().click();
    sort("km_desc");
    expect(rows().length).toBe(PAGE_SIZE);
    more().click();
    search("2025");
    expect(rows().length).toBe(PAGE_SIZE);
    expect(count()).toBe(`250 rutas; se muestran las primeras ${PAGE_SIZE}.`);
  });

  it("exports every route that matches, in the order chosen, not only the rows drawn", async () => {
    const saved: { name: string; blob: Blob }[] = [];
    const createObjectURL = vi.fn(() => "blob:test");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: (createObjectURL.mock.calls.at(-1) as unknown as [Blob])[0] });
    });
    show(many);
    sort("date_asc");
    [...view.querySelectorAll("button")].find((one) => one.textContent === "Exportar CSV")?.click();
    click.mockRestore();
    expect(saved.length).toBe(1);
    expect(saved[0]?.name).toBe("rutas-2026-11-09.csv");
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(saved[0]?.blob as Blob);
    });
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(251);
    expect(lines[1]?.slice(0, 10)).toBe("2025-01-01");
    expect(lines[250]?.slice(0, 10)).toBe("2025-09-07");
    // Nothing is left behind in the page.
    expect(document.querySelector("a[download]")).toBeNull();
  });
});

describe("downloads", () => {
  it("offers the file under its name through a temporary link", () => {
    const createObjectURL = vi.fn(() => "blob:made-up");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.download}|${this.getAttribute("href")}|${this.isConnected}`);
    });
    const blob = new Blob(["x"]);
    downloadBlob("archivo.csv", blob);
    click.mockRestore();
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual(["archivo.csv|blob:made-up|true"]);
    expect(document.querySelector("a")).toBeNull();
  });
});

describe("share card drawing", () => {
  function fakeCanvas(): { canvas: HTMLCanvasElement; texts: string[] } {
    const texts: string[] = [];
    const context = { fillRect: () => undefined, beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined, closePath: () => undefined, fill: () => undefined, fillText: (value: string) => void texts.push(value) };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    return { canvas, texts };
  }
  const list = rides([{ start: "2026-07-04T09:00:00-07:00", km: 70, minutes: 60 }]);

  it("draws the title and every figure, and marks synthetic data only when it is synthetic", () => {
    const demo = fakeCanvas();
    expect(drawCard(demo.canvas, cardContent(list, 2026, true))).toBe(true);
    expect([demo.canvas.width, demo.canvas.height]).toEqual([CARD_SIZE, CARD_SIZE]);
    expect(demo.texts).toEqual([
      "TU 2026 EN MOTO",
      "KILÓMETROS", "70 km",
      "SALIDAS", "1",
      "HORAS EN MARCHA", "1 h",
      "RUTA MÁS LARGA", "70,0 km",
      "MES CON MÁS KM", "julio · 70 km",
      "Ride Log · km según el servicio, unidades sin confirmar",
      "DATOS DE EJEMPLO",
    ]);
    const real = fakeCanvas();
    drawCard(real.canvas, cardContent(list, 2026, false));
    expect(real.texts).not.toContain("DATOS DE EJEMPLO");
    expect(real.texts.length).toBe(demo.texts.length - 1);
  });

  it("says so when the browser gives no canvas", () => {
    expect(drawCard({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement, cardContent(list, 2026, true))).toBe(false);
  });
});

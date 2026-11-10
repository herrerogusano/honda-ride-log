// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { FORBIDDEN_MARK, generateRider } from "../src/demo/generator";
import { createDemoCaller, DEMO_SEED } from "../src/demo/scenarios";
import { formatDate, formatDateLong, formatNumber } from "../src/domain/format";
import { ToolCallError, type ToolCaller, type ToolName } from "../src/service/contract";
import { loadAllRoutes, loadVehicleState } from "../src/service/loader";
import { startApp, type App } from "../src/ui/app";
import { buildRiderData } from "../src/ui/data";
import { downloadBlob } from "../src/ui/download";
import { createMapView } from "../src/ui/mapView";
import { PAGE_SIZE } from "../src/ui/routesView";

vi.mock("../src/ui/download", () => ({ downloadBlob: vi.fn() }));

// Noon in Los Angeles, where the tests run.
const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: DEMO_SEED, nowMs: NOW });
/** What the page may show: routes of 300 m or more. */
const visible = rider.routes.filter((route) => (route.distance_km ?? 0) >= 0.3);
const newest = visible[visible.length - 1] as (typeof visible)[number];
const newestStart = Date.parse(newest.started_at as string);
const lastEnd = Date.parse(rider.routes[rider.routes.length - 1]?.ended_at as string);
const localYear = (iso: string | null): number => new Date(Date.parse(iso ?? "")).getFullYear();

let root: HTMLElement;
/** What the fake browser storage holds. Tests read it here, never through the global. */
let stored = new Map<string, string>();

function mount(hash = ""): App {
  history.replaceState(null, "", hash === "" ? "/" : `/${hash}`);
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
  // jsdom cannot lay out a real map: the Mapa tab gets a surface that draws nothing.
  const surface = { show: () => undefined, clear: () => undefined, resize: () => undefined, destroy: () => undefined };
  return startApp({ root, now: () => NOW, demoDelayMs: 0, createMap: (data, caller, options) => createMapView(data, caller, options, () => surface) });
}

const page = (): string => new XMLSerializer().serializeToString(document);
const text = (): string => document.body.textContent ?? "";
const tab = (name: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((one) => one.textContent === name);
  if (found === undefined) throw new Error(`no tab ${name}`);
  return found;
};
const panelOf = (name: string): HTMLElement => {
  const panel = document.getElementById(tab(name).getAttribute("aria-controls") ?? "");
  if (panel === null) throw new Error(`no panel for ${name}`);
  return panel;
};
const loaded = (): Promise<void> => vi.waitFor(() => expect(root.querySelector('[role="tablist"]')).not.toBeNull());
const button = (label: string, within: ParentNode = document): HTMLButtonElement => {
  const found = [...within.querySelectorAll("button")].find((one) => (one.textContent ?? "").includes(label));
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};
const tileValue = (label: string): string => {
  const term = [...root.querySelectorAll("dt")].find((one) => one.textContent === label);
  return term?.parentElement?.querySelector(".tile-value")?.textContent ?? "";
};
function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeAll(() => {
  // jsdom has no canvas: the card falls back to text, which is what we test here.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  const store = new Map<string, string>();
  stored = store;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
  });
  vi.mocked(downloadBlob).mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("landing and demo mode", () => {
  it("opens on a landing page that offers the demo and asks the service for nothing", () => {
    mount();
    expect(text()).toContain("Ver la demo");
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("starts the demo from the button and says clearly that the data is made up", async () => {
    mount();
    button("Ver la demo").click();
    await loaded();
    const banner = root.querySelector(".demo-banner");
    expect(banner?.hasAttribute("hidden")).toBe(false);
    expect(banner?.textContent).toContain("Modo demo: datos de ejemplo");
    expect(location.hash).toBe("#demo");
  });

  it("starts the demo named in the address", async () => {
    mount("#demo=heavy");
    await loaded();
    expect(root.querySelector<HTMLSelectElement>(".demo-banner select")?.value).toBe("heavy");
    const heavy = generateRider({ seed: DEMO_SEED, nowMs: NOW, profile: "heavy" });
    const rides = heavy.routes.filter((route) => (route.distance_km ?? 0) >= 0.3 && localYear(route.started_at) === 2026);
    expect(rides.length).toBeGreaterThan(1000);
    expect(tileValue("Salidas")).toBe(formatNumber(rides.length));
  });

  it("goes back to the landing page and forgets the demo", async () => {
    mount("#demo");
    await loaded();
    button("Salir de la demo").click();
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(location.hash).toBe("");
    expect(text()).toContain("Ver la demo");
  });

  it("ignores a load that was replaced by a newer one", async () => {
    const app = mount();
    const first = app.startDemo("heavy");
    const second = app.startDemo("empty");
    await Promise.all([first, second]);
    await loaded();
    expect(text()).toContain("Todavía no hay rutas");
    expect(root.querySelectorAll('[role="tablist"]').length).toBe(1);
  });
});

describe("privacy of the rendered page", () => {
  it("never renders identifiers, the plate, the VIN, the dealer or the position", async () => {
    mount("#demo");
    await loaded();
    tab("Rutas").click();
    button("Mostrar más rutas").click();
    panelOf("Rutas").querySelector<HTMLButtonElement>(".row-button")?.click();
    for (const details of root.querySelectorAll("details")) details.open = true;
    const html = page();
    expect(html.length).toBeGreaterThan(20_000);
    // Booleans, so a failure does not print the whole page.
    expect(html.toLowerCase().includes(FORBIDDEN_MARK.toLowerCase())).toBe(false);
    expect(html.includes("rt-DEMO")).toBe(false);
    // Not even the random part of an id, with or without its prefix.
    expect(rider.routes.some((route) => html.includes(route.route_id.slice(7)))).toBe(false);
    expect(html.includes(rider.status.position.label as string)).toBe(false);
    expect(html.includes(String(rider.status.position.latitude))).toBe(false);
    expect(html.includes(String(rider.status.position.longitude))).toBe(false);
    expect(html.includes("example.invalid")).toBe(false);
    // The synthetic rider really carries those values, or this test proves nothing.
    expect(rider.details.registration).toContain(FORBIDDEN_MARK);
    expect(rider.routes[0]?.route_id).toMatch(/^rt-DEMO/);
  });
});

describe("load states", () => {
  it("shows a loading message, then the vehicle, while the routes are on their way", async () => {
    const inner = createDemoService(rider);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ToolCaller = {
      async callTool(name, args) {
        if (name === "list_routes") await gate;
        return inner.callTool(name, args);
      },
    };
    const app = mount();
    const done = app.load(slow, { demo: false });
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Leyendo el estado de la moto");
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain("Cargando rutas"));
    expect(text()).toContain(`Batería ${rider.status.battery} %`);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    release();
    await done;
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(root.querySelector(".demo-banner")?.hasAttribute("hidden")).toBe(true);
  });

  it("stops at a failed vehicle state and shows a code, not a message", async () => {
    const calls: ToolName[] = [];
    const broken: ToolCaller = {
      async callTool(name) {
        calls.push(name);
        throw new ToolCallError("upstream_unavailable", "secret detail eyJhbGciOi");
      },
    };
    await mount().load(broken, { demo: false });
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("No se ha podido leer el estado de la moto.");
    expect(alert?.querySelector("code")?.textContent).toBe("status/tool_error (upstream_unavailable)");
    expect(text()).not.toContain("secret detail");
    expect(text()).not.toContain("eyJ");
    expect(calls).toEqual(["get_vehicle_status"]);
  });

  it("shows the error of the routes with its code and lets the user retry", async () => {
    mount("#demo=error");
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    const alert = root.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("No se han podido cargar las rutas.");
    expect(alert.querySelector("code")?.textContent).toBe("routes/tool_error (upstream_unavailable)");
    expect(text()).toContain("Batería");
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    button("Reintentar", alert).click();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
  });

  it("works without the vehicle details and says which call failed", async () => {
    const inner = createDemoService(rider);
    const partial: ToolCaller = {
      async callTool(name, args) {
        if (name === "get_vehicle_details") throw new ToolCallError("upstream_unavailable", "x");
        return inner.callTool(name, args);
      },
    };
    await mount().load(partial, { demo: false });
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(text()).toContain("No se han podido leer los datos del vehículo.");
    expect(text()).toContain("details/tool_error (upstream_unavailable)");
    expect(text()).not.toContain("Demo 125");
  });

  it("says so when the account has no routes, in every tab", async () => {
    mount("#demo=empty");
    await loaded();
    expect(panelOf("Resumen").textContent).toContain("Todavía no hay rutas en esta cuenta.");
    expect(panelOf("Resumen").textContent).toContain("Batería");
    expect(panelOf("Resumen").textContent).toContain("Mantenimiento");
    expect(panelOf("Resumen").querySelector("svg")).toBeNull();
    expect(panelOf("Rutas").textContent).toContain("No hay rutas que mostrar.");
    expect(panelOf("Mapa").textContent).toContain("Elige una ruta");
  });
});

describe("tabs", () => {
  it("follows the ARIA tabs pattern", async () => {
    mount("#demo");
    await loaded();
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((one) => one.textContent)).toEqual(["Resumen", "Mapa", "Rutas"]);
    expect(tabs.map((one) => one.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((one) => one.tabIndex)).toEqual([0, -1, -1]);
    for (const one of tabs) {
      const panel = document.getElementById(one.getAttribute("aria-controls") ?? "");
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(one.id);
    }
    expect([panelOf("Resumen").hidden, panelOf("Mapa").hidden, panelOf("Rutas").hidden]).toEqual([false, true, true]);
  });

  it("moves with the arrow keys, Home and End, and wraps around", async () => {
    mount("#demo");
    await loaded();
    const press = (name: string, key: string): void => {
      tab(name).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    };
    const selected = (): string | null => root.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null;
    press("Resumen", "ArrowRight");
    expect(selected()).toBe("Mapa");
    expect(document.activeElement).toBe(tab("Mapa"));
    expect([panelOf("Resumen").hidden, panelOf("Mapa").hidden]).toEqual([true, false]);
    press("Mapa", "End");
    expect(selected()).toBe("Rutas");
    press("Rutas", "ArrowRight");
    expect(selected()).toBe("Resumen");
    press("Resumen", "ArrowLeft");
    expect(selected()).toBe("Rutas");
    press("Rutas", "Home");
    expect(selected()).toBe("Resumen");
    press("Resumen", "a");
    expect(selected()).toBe("Resumen");
  });
});

describe("Resumen", () => {
  it("shows the figures of the current year by default and of everything on request", async () => {
    mount("#demo");
    await loaded();
    const thisYear = visible.filter((route) => localYear(route.started_at) === 2026);
    const km = (list: typeof visible): number => list.reduce((sum, route) => sum + (route.distance_km ?? 0), 0);
    expect(thisYear.length).toBeGreaterThan(100);
    expect(thisYear.length).toBeLessThan(visible.length);
    expect(tileValue("Salidas")).toBe(formatNumber(thisYear.length));
    expect(tileValue("Kilómetros")).toBe(`${formatNumber(km(thisYear))} km`);

    const period = root.querySelector<HTMLSelectElement>(".period select") as HTMLSelectElement;
    expect([...period.options].map((option) => option.textContent)).toEqual(["2026", "2025", "2024", "Todo"]);
    choose(period, "all");
    expect(tileValue("Salidas")).toBe(formatNumber(visible.length));
    expect(tileValue("Kilómetros")).toBe(`${formatNumber(km(visible))} km`);
    choose(period, "2025");
    expect(tileValue("Salidas")).toBe(formatNumber(visible.filter((route) => localYear(route.started_at) === 2025).length));
  });

  it("shows battery, last use and odometer, and nothing about where the bike is", async () => {
    mount("#demo");
    await loaded();
    expect(tileValue("Batería")).toBe(`${rider.status.battery} %`);
    expect(tileValue("Odómetro")).toBe(`${formatNumber(rider.status.odometer as number)} km`);
    expect(tileValue("Último uso")).toBe(formatDate(lastEnd));
    expect(text()).not.toMatch(/posici[oó]n actual:/i);
  });

  it("says in a footnote how many short routes are left out and that units are unconfirmed", async () => {
    mount("#demo");
    await loaded();
    const hidden = rider.routes.length - visible.length;
    expect(hidden).toBeGreaterThan(5);
    const notes = root.querySelector(".notes")?.textContent ?? "";
    expect(notes).toContain(`${hidden} rutas de menos de 300 m no cuentan como salidas`);
    expect(notes).toContain("sin confirmar");
    expect(notes).toContain("Ninguna ruta se ha descartado");
    expect(notes).toContain("zona horaria de este navegador");
    expect(notes).toContain("se deja de buscar al encontrar un año natural entero sin rutas");
  });

  it("shows the four streak figures and says what the parked one measures", async () => {
    mount("#demo");
    await loaded();
    const labels = [...root.querySelectorAll("dt")].map((term) => term.textContent);
    for (const label of ["Más días seguidos saliendo", "Más días seguidos parada, entre dos salidas", "Racha en curso saliendo", "Días parada ahora"]) {
      expect(labels).toContain(label);
    }
    expect(tileValue("Más días seguidos saliendo")).toMatch(/^\d+ días?$/);
  });

  it("gives every chart a title and a table with the same figures", async () => {
    mount("#demo");
    await loaded();
    const figures = [...panelOf("Resumen").querySelectorAll("figure")];
    expect(figures.length).toBe(3);
    for (const figure of figures) {
      const drawing = figure.querySelector("svg");
      expect(drawing?.getAttribute("role")).toBe("img");
      const ids = (drawing?.getAttribute("aria-labelledby") ?? "").split(" ");
      expect(ids.length).toBe(2);
      for (const id of ids) expect(document.getElementById(id)?.textContent).not.toBe("");
      expect(figure.querySelector("details table tbody tr")).not.toBeNull();
    }
    const months = figures[0] as HTMLElement;
    expect([...months.querySelectorAll(".chart-legend li")].map((item) => item.textContent)).toEqual(["2024", "2025", "2026"]);
    expect(months.querySelectorAll("tbody tr").length).toBe(12);
  });

  it("offers the share card with figures only", async () => {
    mount("#demo");
    await loaded();
    const card = [...panelOf("Resumen").querySelectorAll("section")].find((one) => one.textContent?.includes("Tarjeta para compartir"));
    expect(card?.textContent).toContain("Tu 2026 en moto (datos de ejemplo)");
    expect(card?.textContent).toContain("Kilómetros:");
    expect(card?.textContent).toContain("Mes con más km:");
    // Without a canvas there is nothing to download.
    expect(button("Descargar tarjeta", card).disabled).toBe(true);
  });
});

describe("maintenance", () => {
  const fields = (): { interval: HTMLInputElement; last: HTMLInputElement; form: HTMLFormElement; result: HTMLElement } => {
    const form = root.querySelector("form.maintenance") as HTMLFormElement;
    const [interval, last] = [...form.querySelectorAll("input")] as [HTMLInputElement, HTMLInputElement];
    return { interval, last, form, result: root.querySelector(".maintenance-result") as HTMLElement };
  };
  const submit = (form: HTMLFormElement): boolean => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  const odometer = rider.status.odometer as number;

  it("says how far the next service is and keeps the two numbers in this browser", async () => {
    mount("#demo");
    await loaded();
    const { interval, last, form, result } = fields();
    expect(result.textContent).toContain("Escribe los dos números");
    interval.value = "6000";
    last.value = String(Math.floor(odometer) - 1000);
    // The form must never be sent anywhere: the page cancels the submission.
    expect(submit(form)).toBe(false);
    const remaining = Math.floor(odometer) - 1000 + 6000 - odometer;
    expect(result.textContent).toContain(`Te faltan ${formatNumber(remaining)} km para la revisión`);
    expect(result.textContent).toContain("Guardado en este navegador.");
    expect(stored.size).toBe(1);
    expect([...stored.keys()][0]).toBe("ride-log.demo.maintenance.v1");
    expect(JSON.parse(stored.get("ride-log.demo.maintenance.v1") as string)).toEqual({
      intervalKm: 6000,
      lastServiceKm: Math.floor(odometer) - 1000,
    });

    // A later visit finds the numbers again.
    document.body.replaceChildren();
    mount("#demo");
    await loaded();
    expect(fields().interval.value).toBe("6000");
    expect(fields().result.textContent).toContain("Te faltan");
  });

  it("says when the service is overdue", async () => {
    mount("#demo");
    await loaded();
    const { interval, last, form, result } = fields();
    interval.value = "1000";
    last.value = String(Math.floor(odometer) - 1500);
    submit(form);
    expect(result.textContent).toContain(`Te has pasado ${formatNumber(odometer - (Math.floor(odometer) - 500))} km de la revisión`);
  });

  it("rejects numbers that make no sense and stores nothing", async () => {
    mount("#demo");
    await loaded();
    const { interval, last, form, result } = fields();
    for (const [a, b] of [["0", "100"], ["", "100"], ["5000", ""], ["5000", "-1"], ["abc", "100"]]) {
      interval.value = a as string;
      last.value = b as string;
      submit(form);
      expect(result.textContent).toContain("Revisa los números");
    }
    expect(stored.size).toBe(0);
  });

  it("forgets the numbers on request", async () => {
    mount("#demo");
    await loaded();
    const { interval, last, form, result } = fields();
    interval.value = "6000";
    last.value = "100";
    submit(form);
    expect(stored.size).toBe(1);
    button("Borrar", form).click();
    expect(stored.size).toBe(0);
    expect(interval.value).toBe("");
    expect(result.textContent).toContain("Números borrados");
  });

  it("keeps the numbers of a real account apart from the demo's", async () => {
    await mount().load(createDemoCaller("commuter", NOW, 0), { demo: false });
    const { interval, last, form } = fields();
    interval.value = "4000";
    last.value = "100";
    submit(form);
    expect([...stored.keys()][0]).toBe("ride-log.maintenance.v1");
  });
});

describe("Rutas", () => {
  const rows = (): HTMLTableRowElement[] => [...panelOf("Rutas").querySelectorAll<HTMLTableRowElement>("tbody tr")];
  const open = async (): Promise<void> => {
    mount("#demo");
    await loaded();
    tab("Rutas").click();
  };

  it("lists the newest routes first, a page at a time, and never the short ones", async () => {
    await open();
    expect(visible.length).toBeGreaterThan(2 * PAGE_SIZE);
    expect(rows().length).toBe(PAGE_SIZE);
    expect(panelOf("Rutas").querySelector(".count")?.textContent).toBe(
      `${formatNumber(visible.length)} rutas; se muestran las primeras ${PAGE_SIZE}.`,
    );
    expect(rows()[0]?.textContent).toContain(formatDate(newestStart));
    button("Mostrar más rutas").click();
    expect(rows().length).toBe(2 * PAGE_SIZE);
    const columns = [...panelOf("Rutas").querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(columns).toEqual(["Fecha", "Salida", "Duración", "Km", "Vel. media (km/h)"]);
  });

  it("searches by date text and sorts by distance", async () => {
    await open();
    const search = panelOf("Rutas").querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    type(search, "sabado 2025");
    expect(rows().length).toBeGreaterThan(5);
    for (const row of rows()) expect(row.querySelector("th")?.textContent).toMatch(/^sáb \d+ \w+ 2025/);
    type(search, "no existe");
    expect(rows().length).toBe(0);
    expect(panelOf("Rutas").querySelector(".count")?.textContent).toBe("Ninguna ruta coincide con la búsqueda.");
    expect(button("Exportar CSV").disabled).toBe(true);
    type(search, "");
    choose(panelOf("Rutas").querySelector("select") as HTMLSelectElement, "km_desc");
    const longest = Math.max(...visible.map((route) => route.distance_km ?? 0));
    expect(rows()[0]?.querySelectorAll("td")[2]?.textContent).toBe(formatNumber(longest, 1));
  });

  it("opens the route in the Mapa tab when its date is pressed", async () => {
    await open();
    rows()[0]?.querySelector("button")?.click();
    expect(tab("Mapa").getAttribute("aria-selected")).toBe("true");
    expect(panelOf("Mapa").hidden).toBe(false);
    expect(panelOf("Mapa").textContent).toContain(formatDateLong(newestStart));
  });

  it("exports what the list shows as a CSV file without identifiers", async () => {
    await open();
    const search = panelOf("Rutas").querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
    type(search, "agosto 2025");
    const expected = visible.filter((route) => {
      const start = new Date(Date.parse(route.started_at ?? ""));
      return start.getFullYear() === 2025 && start.getMonth() === 7;
    }).length;
    expect(expected).toBeGreaterThan(10);
    button("Exportar CSV").click();
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [fileName, blob] = vi.mocked(downloadBlob).mock.calls[0] as [string, Blob];
    expect(fileName).toBe("rutas-2026-11-09-demo.csv");
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(expected + 1);
    expect(lines[0]).toContain("Fecha;Hora de salida");
    for (const line of lines.slice(1)) expect(line).toMatch(/^2025-08-\d{2};/);
    expect(csv).not.toContain("rt-");
  });
});

describe("the switch for routes under 300 m", () => {
  it("leaves them out of the figures by default and counts them when asked", async () => {
    const service = createDemoService(rider);
    const state = await loadVehicleState(service);
    const load = await loadAllRoutes(service, NOW);
    const byDefault = buildRiderData(state, null, load, true, NOW);
    expect(byDefault.shortCounted).toBe(false);
    expect(byDefault.figures.length).toBe(visible.length);
    expect(byDefault.routes.length).toBe(visible.length);
    expect(byDefault.hiddenShort).toBe(rider.routes.length - visible.length);
    const counted = buildRiderData(state, null, load, true, NOW, true);
    expect(counted.figures.length).toBe(rider.routes.length);
    // Listed and drawn routes do not change: short ones stay hidden.
    expect(counted.routes.length).toBe(visible.length);
    expect(counted.shortCounted).toBe(true);
  });
});

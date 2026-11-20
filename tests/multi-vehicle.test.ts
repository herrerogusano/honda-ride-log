// @vitest-environment jsdom
/**
 * Vehicle selection (docs/PLAN.md, section 19): an account with several
 * motorbikes, one at a time. In memory, in jsdom, against the demo service
 * (src/demo/fakeService.ts), which follows the service's contract as read
 * from its code and contract document; not against the real service.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService, DEMO_VEHICLE_ID, type DemoVehicle } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { createDemoCaller, DEMO_SEED, demoFleet } from "../src/demo/scenarios";
import type { AccountData, VehicleOption } from "../src/domain/model";
import { accountSnapshot, restoreAccount, sanitizeVehicleList, sanitizeVehicleStatus, ShapeError } from "../src/domain/sanitize";
import { ToolCallError, type ToolArguments, type ToolCaller, type ToolName } from "../src/service/contract";
import { isVehicleChoiceError, LoadError, loadVehicles } from "../src/service/loader";
import { ServiceError } from "../src/service/mcpClient";
import {
  defaultVehicle,
  keyOfVehicleId,
  memoryChoiceStore,
  selectorOrder,
  vehicleCaller,
  vehicleMemory,
  type ChoiceStore,
} from "../src/service/vehicles";
import { adoptLegacyMaintenance, readMaintenance } from "../src/storage/maintenance";
import { startApp, type App, type LoadOptions } from "../src/ui/app";
import { downloadBlob } from "../src/ui/download";
import { errorText } from "../src/ui/errors";
import { createMapView } from "../src/ui/mapView";
import { vehicleLabel } from "../src/ui/vehiclePicker";

vi.mock("../src/ui/download", () => ({ downloadBlob: vi.fn() }));

// Noon in Los Angeles, where the tests run.
const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const DAY_MS = 86_400_000;

let root: HTMLElement;
let stored = new Map<string, string>();

function mount(): App {
  history.replaceState(null, "", "/");
  document.body.replaceChildren();
  root = document.createElement("main");
  document.body.append(root);
  const surface = { show: () => undefined, clear: () => undefined, frame: (_l: unknown, _f: unknown, settled: () => void) => settled(), paint: () => undefined, resize: () => undefined, destroy: () => undefined };
  return startApp({ root, now: () => NOW, demoDelayMs: 0, createMap: (data, caller, options) => createMapView(data, caller, options, () => surface) });
}

const loaded = (): Promise<void> => vi.waitFor(() => expect(root.querySelector('nav[aria-label="Secciones"]')).not.toBeNull());
const text = (): string => document.body.textContent ?? "";
const picker = (): HTMLSelectElement | null => root.querySelector<HTMLSelectElement>(".vehicle-select");
const tileValue = (label: string): string => {
  const term = [...root.querySelectorAll(".plate dt")].find((one) => one.textContent === label);
  return term?.parentElement?.querySelector(".tile-value")?.textContent ?? "";
};
/** The share card's block (jsdom has no canvas: the card is its text). */
const cardText = (): string =>
  [...root.querySelectorAll("section.block")].find((one) => one.querySelector("h3")?.textContent === "Tarjeta para compartir")?.textContent ?? "";
const chosenPeriod = (): string => root.querySelector<HTMLSelectElement>(".period-select:not(.vehicle-select)")?.value ?? "";
function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
/** A page's DOM with the generated ids taken out, to compare two drawings of the same data. */
function shape(node: Node): string {
  return new XMLSerializer().serializeToString(node).replace(/-\d+(?=["\s])/g, "-#");
}

/** A caller that records each call and its `vehicle_id`. */
function recording(inner: ToolCaller): ToolCaller & { readonly log: { name: ToolName; vehicle: string | undefined }[] } {
  const log: { name: ToolName; vehicle: string | undefined }[] = [];
  return {
    log,
    callTool<N extends ToolName>(name: N, args: ToolArguments[N]) {
      log.push({ name, vehicle: (args as { vehicle_id?: string }).vehicle_id });
      return inner.callTool(name, args);
    },
  };
}

/** The demo service as an older deployment without `list_vehicles` answers it. */
function withoutListVehicles(inner: ToolCaller): ToolCaller {
  return {
    callTool(name, args) {
      if (name === "list_vehicles") return Promise.reject(new ToolCallError("unknown_tool", "Unknown tool: list_vehicles"));
      return inner.callTool(name, args);
    },
  };
}

const fleet = (): readonly DemoVehicle[] => demoFleet(NOW);

beforeAll(() => {
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

/** A raw `list_vehicles` answer from plain entries. */
function rawList(entries: { id: string; model: string | null; registration: string | null; cancelled?: boolean; last?: number | null }[]): unknown {
  const status = generateRider({ seed: 1, nowMs: NOW }).status;
  return {
    vehicles: entries.map((one) => ({
      vehicle_id: one.id,
      model: one.model,
      registration: one.registration,
      cancelled: one.cancelled === true,
      status: { ...status, last_communication: one.last ?? null, ...(one.cancelled === true ? { vehicle_cancelled: true, state_warning: "not live" } : {}) },
    })),
    vehicle_count: entries.length,
    selection_required: entries.length > 1,
    selection_basis: "mapit_dashboard_filter",
    selection_hint: "hint",
  };
}

describe("the list of motorbikes, sanitized", () => {
  it("keeps the model, the cancelled flag and the state, and of the registration only three characters when two share a model", () => {
    const list = sanitizeVehicleList(
      rawList([
        { id: "a", model: "Forza 125", registration: "1234 BCD", last: 3 },
        { id: "b", model: "Forza 125", registration: "9876-KLM", last: 2 },
        { id: "c", model: "CB500F", registration: "5555 XYZ", cancelled: true, last: 9 },
      ]),
    );
    expect(list.map((one) => [one.model, one.twinSuffix, one.cancelled, one.order])).toEqual([
      ["Forza 125", "BCD", false, 0],
      ["Forza 125", "KLM", false, 1],
      ["CB500F", null, true, 2],
    ]);
    expect(list[2]?.state.cancelled).toBe(true);
    expect(list[0]?.state.cancelled).toBeUndefined();
    // Nothing else of the registration, the id or the position is reachable.
    const serialized = JSON.stringify(list);
    for (const word of ["1234", "9876", "5555", "XYZ", "registration", "position", "latitude"]) expect(serialized).not.toContain(word);
    expect(Object.keys(list[0] as object).sort()).toEqual(["cancelled", "model", "order", "ref", "state", "twinSuffix"]);
    expect(Object.keys((list[0] as VehicleOption).ref)).toEqual([]);
  });

  it("refuses an empty list and a repeated id, and reads the cancelled flag of a status", () => {
    expect(() => sanitizeVehicleList(rawList([]))).toThrow(ShapeError);
    expect(() => sanitizeVehicleList(rawList([{ id: "a", model: null, registration: null }, { id: "a", model: null, registration: null }]))).toThrow(ShapeError);
    const status = generateRider({ seed: 1, nowMs: NOW }).status;
    expect(sanitizeVehicleStatus({ ...status, vehicle_cancelled: true, state_warning: "x" }).cancelled).toBe(true);
    expect("cancelled" in sanitizeVehicleStatus(status)).toBe(false);
  });

  it("labels each one by its model, with the end of the registration only for twins and a mark for a cancelled one", () => {
    const list = sanitizeVehicleList(
      rawList([
        { id: "a", model: "Forza 125", registration: "1234 BCD" },
        { id: "b", model: "Forza 125", registration: "9876 KLM" },
        { id: "c", model: "CB500F", registration: "5555 XYZ", cancelled: true },
        { id: "d", model: null, registration: null },
      ]),
    );
    expect(list.map(vehicleLabel)).toEqual(["Forza 125 · …BCD", "Forza 125 · …KLM", "CB500F · dada de baja", "Tu moto"]);
  });
});

describe("choosing the motorbike", () => {
  const list = (entries: Parameters<typeof rawList>[0]): readonly VehicleOption[] => sanitizeVehicleList(rawList(entries));

  it("shows first the one that reported last, the first listed on a tie or without times, and a cancelled one only if all are", () => {
    expect(defaultVehicle(list([{ id: "a", model: "A", registration: null, last: 1 }, { id: "b", model: "B", registration: null, last: 5 }])).model).toBe("B");
    expect(defaultVehicle(list([{ id: "a", model: "A", registration: null, last: 5 }, { id: "b", model: "B", registration: null, last: 5 }])).model).toBe("A");
    expect(defaultVehicle(list([{ id: "a", model: "A", registration: null }, { id: "b", model: "B", registration: null }])).model).toBe("A");
    expect(defaultVehicle(list([{ id: "a", model: "A", registration: null }, { id: "b", model: "B", registration: null, last: 1 }])).model).toBe("B");
    expect(
      defaultVehicle(list([{ id: "a", model: "A", registration: null, cancelled: true, last: 9 }, { id: "b", model: "B", registration: null, last: 1 }])).model,
    ).toBe("B");
    expect(
      defaultVehicle(list([{ id: "a", model: "A", registration: null, cancelled: true, last: 1 }, { id: "b", model: "B", registration: null, cancelled: true, last: 9 }])).model,
    ).toBe("B");
  });

  it("lists cancelled ones last", () => {
    const ordered = selectorOrder(
      list([
        { id: "a", model: "A", registration: null, cancelled: true },
        { id: "b", model: "B", registration: null },
        { id: "c", model: "C", registration: null },
      ]),
    );
    expect(ordered.map((one) => one.model)).toEqual(["B", "C", "A"]);
  });

  it("sends the vehicle_id with every vehicle tool, never with list_vehicles, through one caller per motorbike", async () => {
    const service = createDemoService(fleet());
    const [first] = sanitizeVehicleList(await service.callTool("list_vehicles", {}));
    const caller = vehicleCaller(service, (first as VehicleOption).ref);
    expect(vehicleCaller(service, (first as VehicleOption).ref)).toBe(caller);
    await caller.callTool("get_vehicle_details", {});
    await caller.callTool("list_vehicles", {});
    expect(service.vehicleIds).toEqual([undefined, "veh-DEMO-0001", undefined]);
  });

  it("names a motorbike in storage by 16 hex digits of a hash, never by its id", async () => {
    const key = await keyOfVehicleId("veh-DEMO-0001");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(await keyOfVehicleId("veh-DEMO-0001")).toBe(key);
    expect(await keyOfVehicleId("veh-DEMO-0002")).not.toBe(key);
  });

  it("remembers the choice only while it is in the list, and forgets it on request", async () => {
    const store = memoryChoiceStore();
    const memory = vehicleMemory(store);
    const vehicles = sanitizeVehicleList(await createDemoService(fleet()).callTool("list_vehicles", {}));
    expect(memory.recall(vehicles)).toBeNull();
    memory.remember(vehicles[1] as VehicleOption);
    expect(store.read()).toBe("veh-DEMO-0002");
    expect(memory.recall(vehicles)).toBe(vehicles[1]);
    expect(await memory.storedKey()).toBe(await keyOfVehicleId("veh-DEMO-0002"));
    store.write("veh-gone");
    expect(memory.recall(vehicles)).toBeNull();
    memory.forget();
    expect(store.read()).toBeNull();
    expect(await memory.storedKey()).toBeNull();
  });
});

describe("a service without list_vehicles", () => {
  it("is read as no vehicle selection: an unknown tool, a JSON-RPC «not found» or an unreadable refusal", async () => {
    const failing = (error: Error): ToolCaller => ({ callTool: () => Promise.reject(error) });
    expect(await loadVehicles(failing(new ToolCallError("unknown_tool", "x")))).toBeNull();
    expect(await loadVehicles(failing(new ToolCallError("tool_error", "x")))).toBeNull();
    expect(await loadVehicles(failing(new ServiceError("rpc_error", "-32601")))).toBeNull();
    expect(await loadVehicles(failing(new ServiceError("rpc_error", "-32602")))).toBeNull();
    // A real failure stays a failure of its own step.
    await expect(loadVehicles(failing(new ToolCallError("mapit_unavailable", "x")))).rejects.toMatchObject({ step: "vehicles", kind: "tool_error", detail: "mapit_unavailable" });
    await expect(loadVehicles(failing(new ServiceError("rpc_error", "-32000")))).rejects.toMatchObject({ step: "vehicles", kind: "rpc_error" });
  });

  it("loads exactly as before: no vehicle_id on any call and no selector", async () => {
    const caller = recording(withoutListVehicles(createDemoCaller("commuter", NOW, 0)));
    await mount().load(caller, { demo: false });
    await loaded();
    expect(caller.log.map((one) => one.name).slice(0, 3)).toEqual(["list_vehicles", "get_vehicle_status", "get_vehicle_details"]);
    expect(caller.log.every((one) => one.vehicle === undefined)).toBe(true);
    expect(picker()).toBeNull();
    expect(root.querySelector(".hero-eyebrow")?.textContent).toBe("Demo 125 · Ride Log");
  });
});

describe("one motorbike: the page is the same as before vehicle selection", () => {
  it("draws the very same page as without list_vehicles, with no selector and no new text", async () => {
    await mount().load(withoutListVehicles(createDemoCaller("commuter", NOW, 0)), { demo: false });
    await loaded();
    const before = shape(root.querySelector(".content") as Node);
    const caller = recording(createDemoCaller("commuter", NOW, 0));
    await mount().load(caller, { demo: false });
    await loaded();
    expect(shape(root.querySelector(".content") as Node)).toBe(before);
    expect(picker()).toBeNull();
    expect(text()).not.toContain("motos en tu cuenta");
    expect(text()).not.toContain("Dada de baja");
    // The one motorbike's id goes with every vehicle tool (allowed, and the same answer).
    expect(caller.log.filter((one) => one.name !== "list_vehicles").every((one) => one.vehicle === DEMO_VEHICLE_ID)).toBe(true);
    // The same number of calls: the list replaces get_vehicle_status.
    expect(caller.log.filter((one) => one.name === "get_vehicle_status")).toHaveLength(0);
  });

  it("moves the maintenance numbers kept before vehicle selection to the only motorbike", async () => {
    stored.set("ride-log.maintenance.v1", JSON.stringify({ intervalKm: 6000, lastServiceKm: 100 }));
    await mount().load(createDemoCaller("commuter", NOW, 0), { demo: false });
    await loaded();
    const key = `ride-log.maintenance.v1.${await keyOfVehicleId(DEMO_VEHICLE_ID)}`;
    expect([...stored.keys()]).toEqual([key]);
    expect(root.querySelector<HTMLInputElement>("form.maintenance input")?.value).toBe("6000");
  });
});

describe("several motorbikes", () => {
  async function openFleet(options: Partial<LoadOptions> = {}): Promise<ReturnType<typeof recording>> {
    const caller = recording(createDemoService(fleet()));
    await mount().load(caller, { demo: false, ...options });
    await loaded();
    return caller;
  }

  it("puts the selector in place of the line that names the motorbike, with the count and the default chosen", async () => {
    const caller = await openFleet();
    const select = picker() as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((one) => one.textContent)).toEqual(["Demo 125 · …BCD", "Demo 125 · …KLM", "Demo 500 · dada de baja"]);
    expect(select.selectedOptions[0]?.textContent).toBe("Demo 125 · …BCD");
    expect(root.querySelector(".vehicle-count")?.textContent).toBe("3 motos en tu cuenta");
    expect(root.querySelector("p.hero-eyebrow")).toBeNull();
    expect(root.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Moto");
    // One list, then every vehicle tool with the chosen id.
    expect(caller.log.filter((one) => one.name === "list_vehicles")).toHaveLength(1);
    expect(caller.log.filter((one) => one.name !== "list_vehicles").every((one) => one.vehicle === "veh-DEMO-0001")).toBe(true);
  });

  it("switches with one load and no new list, keeps a year it has rides in and takes its last year otherwise", async () => {
    const caller = await openFleet();
    expect(chosenPeriod()).toBe("2026");
    const before = caller.log.length;
    choose(picker() as HTMLSelectElement, "1");
    await vi.waitFor(() => expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 125 · …KLM"));
    await loaded();
    const switchCalls = caller.log.slice(before);
    expect(switchCalls.map((one) => one.name)).not.toContain("list_vehicles");
    expect(switchCalls[0]?.name).toBe("get_vehicle_status");
    expect(switchCalls.every((one) => one.vehicle === "veh-DEMO-0002")).toBe(true);
    // The second one rode in 2026 too.
    expect(chosenPeriod()).toBe("2026");
    // The cancelled one stopped riding over a year ago: its last year with rides.
    choose(picker() as HTMLSelectElement, "2");
    await vi.waitFor(() => expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 500 · dada de baja"));
    await loaded();
    const last = new Date(NOW - 400 * DAY_MS).getFullYear();
    expect(chosenPeriod()).toBe(String(last));
  });

  it("keeps «Todo» when switching", async () => {
    await openFleet();
    choose(root.querySelector<HTMLSelectElement>(".period-select:not(.vehicle-select)") as HTMLSelectElement, "all");
    choose(picker() as HTMLSelectElement, "2");
    await vi.waitFor(() => expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 500 · dada de baja"));
    await loaded();
    expect(chosenPeriod()).toBe("all");
  });

  it("shows a cancelled motorbike as not available, with its routes and card, and a notice instead of the maintenance form", async () => {
    await openFleet();
    choose(picker() as HTMLSelectElement, "2");
    await vi.waitFor(() => expect(root.querySelector(".hero .vehicle-badge")).not.toBeNull());
    await loaded();
    expect(root.querySelector(".vehicle-pick .vehicle-badge")?.textContent).toBe("Dada de baja");
    expect(root.querySelector(".vehicle-count")).toBeNull();
    expect(root.querySelector(".plate-head .vehicle-badge")).not.toBeNull();
    expect(tileValue("Estado")).toBe("No disponible");
    expect(tileValue("Batería")).toBe("");
    expect(tileValue("Odómetro")).toBe("");
    expect(tileValue("Última salida")).not.toBe("—");
    expect(root.querySelector("form.maintenance")).toBeNull();
    expect(text()).toContain("No disponible: esta moto está dada de baja");
    expect(root.querySelectorAll(".routes-table tbody tr").length).toBeGreaterThan(0);
    expect(cardText()).toContain("km");
  });

  it("one cancelled motorbike alone keeps the line that names it, with its mark", async () => {
    const [, , cancelled] = fleet();
    await mount().load(createDemoService([cancelled as DemoVehicle]), { demo: false });
    await loaded();
    expect(picker()).toBeNull();
    expect(root.querySelector(".vehicle-pick p.eyebrow")?.textContent).toBe("Demo 500 · Ride Log");
    expect(root.querySelector(".vehicle-pick .vehicle-badge")?.textContent).toBe("Dada de baja");
  });

  it("keeps the registration's end in the selector alone: never in the card, the CSV, storage or the counters", async () => {
    const onDemo = vi.fn();
    const caller = recording(createDemoService(fleet()));
    document.body.replaceChildren();
    root = document.createElement("main");
    document.body.append(root);
    const app = startApp({ root, now: () => NOW, demoDelayMs: 0, onDemo });
    const kept: unknown[] = [];
    await app.load(caller, { demo: false, onLoaded: (data) => kept.push(accountSnapshot(data)) });
    await loaded();
    const selectorText = picker()?.textContent ?? "";
    expect(selectorText).toContain("BCD");
    expect(cardText()).toContain("km");
    // Everything on screen but the selector.
    const rest = [...root.querySelectorAll(".content > *")].map((one) => {
      const copy = one.cloneNode(true) as HTMLElement;
      copy.querySelector(".vehicle-pick")?.remove();
      return copy.textContent ?? "";
    });
    for (const tail of ["BCD", "KLM", "XYZ", "DEMO-", "veh-DEMO"]) {
      expect(rest.join(" ")).not.toContain(tail);
      expect(cardText()).not.toContain(tail);
      expect(JSON.stringify(kept)).not.toContain(tail);
      for (const [key, value] of stored) expect(key + value).not.toContain(tail);
    }
    const csvButton = [...root.querySelectorAll("button")].find((one) => one.textContent === "Exportar CSV") as HTMLButtonElement;
    csvButton.click();
    const [, blob] = vi.mocked(downloadBlob).mock.calls[0] as [string, Blob];
    const csv = await blob.text();
    for (const tail of ["BCD", "KLM", "XYZ", "DEMO"]) expect(csv).not.toContain(tail);
    expect(onDemo).not.toHaveBeenCalled();
  });

  it("gives each motorbike its own maintenance numbers, and the old pair to the first one listed", async () => {
    stored.set("ride-log.maintenance.v1", JSON.stringify({ intervalKm: 5000, lastServiceKm: 10 }));
    await openFleet();
    const [k1, k2] = await Promise.all([keyOfVehicleId("veh-DEMO-0001"), keyOfVehicleId("veh-DEMO-0002")]);
    expect(stored.has("ride-log.maintenance.v1")).toBe(false);
    expect(readMaintenance({ scope: "account", vehicleKey: k1 })).toEqual({ intervalKm: 5000, lastServiceKm: 10 });
    expect(root.querySelector<HTMLInputElement>("form.maintenance input")?.value).toBe("5000");
    choose(picker() as HTMLSelectElement, "1");
    await vi.waitFor(() => expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 125 · …KLM"));
    await loaded();
    expect(root.querySelector<HTMLInputElement>("form.maintenance input")?.value).toBe("");
    const [interval, last] = [...root.querySelectorAll<HTMLInputElement>("form.maintenance input")] as [HTMLInputElement, HTMLInputElement];
    interval.value = "3000";
    last.value = "20";
    root.querySelector("form.maintenance")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(readMaintenance({ scope: "account", vehicleKey: k2 })).toEqual({ intervalKm: 3000, lastServiceKm: 20 });
    expect(readMaintenance({ scope: "account", vehicleKey: k1 })).toEqual({ intervalKm: 5000, lastServiceKm: 10 });
    for (const key of stored.keys()) expect(key).not.toContain("veh-DEMO");
  });

  it("never adopts the old pair twice, nor over a motorbike's own", async () => {
    const [k1, k2] = await Promise.all([keyOfVehicleId("a"), keyOfVehicleId("b")]);
    stored.set("ride-log.maintenance.v1", JSON.stringify({ intervalKm: 5000, lastServiceKm: 10 }));
    stored.set(`ride-log.maintenance.v1.${k1}`, JSON.stringify({ intervalKm: 1000, lastServiceKm: 1 }));
    adoptLegacyMaintenance("account", k1);
    expect(readMaintenance({ scope: "account", vehicleKey: k1 })).toEqual({ intervalKm: 1000, lastServiceKm: 1 });
    adoptLegacyMaintenance("account", k2);
    expect(readMaintenance({ scope: "account", vehicleKey: k2 })).toEqual({ intervalKm: 5000, lastServiceKm: 10 });
    expect(stored.has("ride-log.maintenance.v1")).toBe(false);
    expect(() => readMaintenance({ scope: "account", vehicleKey: "veh-DEMO-0001" })).not.toThrow();
    expect(readMaintenance({ scope: "account", vehicleKey: "veh-DEMO-0001" })).toBeNull();
  });

  it("remembers the motorbike chosen through the store it is given", async () => {
    const store = memoryChoiceStore();
    await openFleet({ vehicles: vehicleMemory(store) });
    expect(store.read()).toBe("veh-DEMO-0001");
    choose(picker() as HTMLSelectElement, "1");
    await vi.waitFor(() => expect(store.read()).toBe("veh-DEMO-0002"));
    await loaded();
    // A new load of the account (a reload) opens the remembered one.
    const caller = recording(createDemoService(fleet()));
    await mount().load(caller, { demo: false, vehicles: vehicleMemory(store) });
    await loaded();
    expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 125 · …KLM");
    expect(caller.log.filter((one) => one.name !== "list_vehicles").every((one) => one.vehicle === "veh-DEMO-0002")).toBe(true);
  });

  it("works the same in the demo at #demo=motos", async () => {
    history.replaceState(null, "", "/#demo=motos");
    document.body.replaceChildren();
    root = document.createElement("main");
    document.body.append(root);
    startApp({ root, now: () => NOW, demoDelayMs: 0 });
    await loaded();
    expect(picker()?.options.length).toBe(3);
    expect(text()).toContain("3 motos en tu cuenta");
    // The plain #demo keeps one motorbike.
    history.replaceState(null, "", "/#demo");
    document.body.replaceChildren();
    root = document.createElement("main");
    document.body.append(root);
    startApp({ root, now: () => NOW, demoDelayMs: 0 });
    await loaded();
    expect(picker()).toBeNull();
  });
});

describe("the copy kept in the tab, per motorbike", () => {
  async function keptCopy(id: string): Promise<AccountData> {
    const kept: AccountData[] = [];
    const store = memoryChoiceStore();
    store.write(id);
    await mount().load(createDemoService(fleet()), { demo: false, vehicles: vehicleMemory(store), onLoaded: (data) => kept.push(data) });
    await loaded();
    return restoreAccount(accountSnapshot(kept[0] as AccountData));
  }

  it("is tagged with the hashed key of its motorbike, never the id", async () => {
    const copy = await keptCopy("veh-DEMO-0002");
    expect(copy.vehicleKey).toBe(await keyOfVehicleId("veh-DEMO-0002"));
    expect(JSON.stringify(accountSnapshot(copy))).not.toContain("veh-DEMO");
  });

  it("is painted only under the motorbike it was loaded for", async () => {
    const copy = await keptCopy("veh-DEMO-0002");
    // The tab now says the other motorbike is chosen: the copy is not shown, the account loads whole.
    const store: ChoiceStore = memoryChoiceStore();
    store.write("veh-DEMO-0001");
    let release: () => void = () => undefined;
    const listed = new Promise<void>((resolve) => (release = resolve));
    const service = createDemoService(fleet());
    const caller = recording({
      async callTool(name, args) {
        if (name === "list_vehicles") await listed;
        return service.callTool(name, args);
      },
    });
    const app = mount().load(caller, { demo: false, saved: copy, vehicles: vehicleMemory(store) });
    // Not even for a moment: while the list is on its way, the page shows the loading stage.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector('nav[aria-label="Secciones"]')).toBeNull();
    release();
    await app;
    await loaded();
    expect(caller.log.map((one) => one.name)).toContain("list_routes");
    expect(caller.log.filter((one) => one.name !== "list_vehicles").every((one) => one.vehicle === "veh-DEMO-0001")).toBe(true);
  });

  it("is painted at once under its own motorbike, and the selector comes with the list", async () => {
    const copy = await keptCopy("veh-DEMO-0002");
    const store: ChoiceStore = memoryChoiceStore();
    store.write("veh-DEMO-0002");
    const caller = recording(createDemoService(fleet()));
    await mount().load(caller, { demo: false, saved: copy, vehicles: vehicleMemory(store) });
    await loaded();
    await vi.waitFor(() => expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 125 · …KLM"));
    expect(caller.log.map((one) => one.name)).toEqual(["list_vehicles", "get_vehicle_details"]);
    expect(caller.log[1]?.vehicle).toBe("veh-DEMO-0002");
  });

  it("refuses a damaged motorbike key", async () => {
    const copy = await keptCopy("veh-DEMO-0001");
    const snapshot = accountSnapshot(copy) as Record<string, unknown>;
    expect(() => restoreAccount({ ...snapshot, k: "veh-DEMO-0001" })).toThrow(ShapeError);
    expect(() => restoreAccount({ ...snapshot, c: false })).toThrow(ShapeError);
    const withoutKey = { ...snapshot };
    delete withoutKey["k"];
    expect(restoreAccount(withoutKey).vehicleKey).toBeUndefined();
  });
});

describe("a choice the service does not take", () => {
  it("says so in Spanish in both builds, with «Reintentar»", () => {
    for (const code of ["vehicle_selection_required", "vehicle_not_found"]) {
      for (const publicService of [false, true]) {
        const text = errorText(new LoadError("routes", "tool_error", code), publicService);
        expect(text.action).toBe("retry");
        expect(text.explanation).toContain("lista de motos");
      }
    }
    expect(isVehicleChoiceError(new LoadError("details", "tool_error", "vehicle_not_found"))).toBe(true);
    expect(isVehicleChoiceError(new LoadError("details", "tool_error", "mapit_unavailable"))).toBe(false);
  });

  it("«Reintentar» forgets the kept choice and reads the list again", async () => {
    const service = createDemoService(fleet());
    let refuse = true;
    const caller = recording({
      callTool(name, args) {
        if (refuse && name === "get_vehicle_details") return Promise.reject(new ToolCallError("vehicle_not_found", "gone"));
        if (refuse && name === "list_routes") return Promise.reject(new ToolCallError("vehicle_not_found", "gone"));
        return service.callTool(name, args);
      },
    });
    const store = memoryChoiceStore();
    store.write("veh-DEMO-0002");
    await mount().load(caller, { demo: false, vehicles: vehicleMemory(store) });
    const alert = await vi.waitFor(() => {
      const found = root.querySelector('[role="alert"]');
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(alert.textContent).toContain("Esa moto ya no aparece en tu cuenta");
    expect(alert.querySelector("code")?.textContent).toBe("routes/tool_error (vehicle_not_found)");
    refuse = false;
    const lists = caller.log.filter((one) => one.name === "list_vehicles").length;
    [...alert.querySelectorAll("button")].find((one) => one.textContent === "Reintentar")?.click();
    await loaded();
    expect(caller.log.filter((one) => one.name === "list_vehicles").length).toBe(lists + 1);
    // Forgotten: the default motorbike is shown, and remembered instead.
    expect(picker()?.selectedOptions[0]?.textContent).toBe("Demo 125 · …BCD");
    expect(store.read()).toBe("veh-DEMO-0001");
  });

  it("the demo service answers like the real one: several motorbikes need an id, and a wrong id is not found", async () => {
    const service = createDemoService(fleet());
    await expect(service.callTool("get_vehicle_status", {})).rejects.toMatchObject({ code: "vehicle_selection_required" });
    await expect(service.callTool("get_vehicle_status", { vehicle_id: "nope" })).rejects.toMatchObject({ code: "vehicle_not_found" });
    const single = createDemoService(generateRider({ seed: DEMO_SEED, nowMs: NOW }));
    await expect(single.callTool("get_vehicle_status", {})).resolves.toBeTruthy();
  });
});

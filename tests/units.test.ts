import { ESLint } from "eslint";
import { beforeEach, describe, expect, it } from "vitest";
import { SHORT_ROUTES_COUNT_IN_FIGURES, SUMMARY_DEFAULT_PERIOD } from "../src/config";
import { createDemoCaller, DEMO_SCENARIOS, scenarioFromHash } from "../src/demo/scenarios";
import { maintenanceStatus, validPlan } from "../src/domain/maintenance";
import { ToolCallError, type RawRouteList } from "../src/service/contract";
import { LoadError } from "../src/service/loader";
import { clearMaintenance, readMaintenance, writeMaintenance } from "../src/storage/maintenance";
import { cardContent, cardText } from "../src/ui/card";
import { errorText } from "../src/ui/errors";
import { selectRoutes } from "../src/ui/routesView";
import { rides } from "./helpers";

describe("open product answers", () => {
  it("are the ones the organizer gave for phase 2", () => {
    // Changing an answer means changing src/config.ts and this test on purpose.
    expect(SHORT_ROUTES_COUNT_IN_FIGURES).toBe(false);
    expect(SUMMARY_DEFAULT_PERIOD).toBe("current_year");
  });
});

describe("maintenance arithmetic", () => {
  it("says how many km are left, or by how many the service is overdue", () => {
    expect(maintenanceStatus({ intervalKm: 6000, lastServiceKm: 12000 }, 15500)).toEqual({ dueAtKm: 18000, remainingKm: 2500 });
    expect(maintenanceStatus({ intervalKm: 6000, lastServiceKm: 12000 }, 18000)).toEqual({ dueAtKm: 18000, remainingKm: 0 });
    expect(maintenanceStatus({ intervalKm: 6000, lastServiceKm: 12000 }, 18750)).toEqual({ dueAtKm: 18000, remainingKm: -750 });
  });

  it("accepts only two sane numbers", () => {
    expect(validPlan(6000, 12000)).toEqual({ intervalKm: 6000, lastServiceKm: 12000 });
    expect(validPlan(1, 0)).toEqual({ intervalKm: 1, lastServiceKm: 0 });
    expect(validPlan(100_000, 10_000_000)).not.toBeNull();
    for (const [interval, last] of [
      [0, 100], [-5, 100], [100_001, 100], [6000, -1], [6000, 10_000_001],
      [Number.NaN, 100], [6000, Number.POSITIVE_INFINITY], ["6000", 100], [6000, null], [undefined, undefined],
    ]) {
      expect(validPlan(interval, last)).toBeNull();
    }
  });
});

describe("maintenance storage", () => {
  let store: Map<string, string>;
  let failing = false;

  beforeEach(() => {
    store = new Map();
    failing = false;
    const guard = (): void => {
      if (failing) throw new Error("storage disabled");
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (guard(), store.get(key) ?? null),
        setItem: (key: string, value: string) => (guard(), void store.set(key, value)),
        removeItem: (key: string) => (guard(), void store.delete(key)),
      },
    });
  });

  it("writes the two numbers and nothing else, and reads them back", () => {
    const plan = { intervalKm: 6000, lastServiceKm: 12000, token: "eyJ-must-not-be-stored" };
    expect(writeMaintenance("account", plan)).toBe(true);
    expect([...store.keys()]).toEqual(["ride-log.maintenance.v1"]);
    expect(store.get("ride-log.maintenance.v1")).toBe('{"intervalKm":6000,"lastServiceKm":12000}');
    expect(readMaintenance("account")).toEqual({ intervalKm: 6000, lastServiceKm: 12000 });
  });

  it("keeps the demo's numbers apart from the account's", () => {
    writeMaintenance("demo", { intervalKm: 1000, lastServiceKm: 1 });
    expect(readMaintenance("account")).toBeNull();
    writeMaintenance("account", { intervalKm: 6000, lastServiceKm: 2 });
    expect(readMaintenance("demo")).toEqual({ intervalKm: 1000, lastServiceKm: 1 });
    clearMaintenance("demo");
    expect(readMaintenance("demo")).toBeNull();
    expect(readMaintenance("account")).toEqual({ intervalKm: 6000, lastServiceKm: 2 });
  });

  it("refuses to write a plan that is not valid", () => {
    expect(writeMaintenance("account", { intervalKm: 0, lastServiceKm: 5 })).toBe(false);
    expect(store.size).toBe(0);
  });

  it("treats damaged or foreign content as no plan", () => {
    for (const content of ["", "not json", "null", "[]", '"text"', '{"intervalKm":"6000","lastServiceKm":1}', '{"intervalKm":-1,"lastServiceKm":1}', '{"intervalKm":6000}']) {
      store.set("ride-log.maintenance.v1", content);
      expect(readMaintenance("account")).toBeNull();
    }
  });

  it("survives a browser that refuses storage", () => {
    failing = true;
    expect(readMaintenance("account")).toBeNull();
    expect(writeMaintenance("account", { intervalKm: 6000, lastServiceKm: 1 })).toBe(false);
    expect(() => clearMaintenance("account")).not.toThrow();
  });
});

describe("demo scenarios", () => {
  it("reads the scenario from the address fragment", () => {
    expect(scenarioFromHash("")).toBeNull();
    expect(scenarioFromHash("#")).toBeNull();
    expect(scenarioFromHash("#other")).toBeNull();
    expect(scenarioFromHash("#demostration")).toBeNull();
    expect(scenarioFromHash("#demo")).toBe("commuter");
    expect(scenarioFromHash("#demo=heavy")).toBe("heavy");
    expect(scenarioFromHash("#demo=empty")).toBe("empty");
    expect(scenarioFromHash("#demo=error")).toBe("error");
    expect(scenarioFromHash("#demo=unknown")).toBe("commuter");
    expect(scenarioFromHash("#demo=")).toBe("commuter");
    expect(scenarioFromHash("#demo&x")).toBeNull();
    expect(scenarioFromHash("#demo=heavy2")).toBeNull();
    expect(DEMO_SCENARIOS.map((one) => one.id)).toEqual(["commuter", "heavy", "empty", "error"]);
  });

  it("serves an account without routes and a service that fails on the second list", async () => {
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    const period = { from_time: "2026-07-01", to_time: "2027-01-01" };
    const empty = (await createDemoCaller("empty", now, 0).callTool("list_routes", period)) as RawRouteList;
    expect([empty.routes.length, empty.matched_routes, empty.truncated]).toEqual([0, 0, false]);
    const full = (await createDemoCaller("commuter", now, 0).callTool("list_routes", period)) as RawRouteList;
    expect(full.routes.length).toBeGreaterThan(50);
    const heavy = (await createDemoCaller("heavy", now, 0).callTool("list_routes", { from_time: "2026-01-01", to_time: "2026-07-01" })) as RawRouteList;
    expect(heavy.truncated).toBe(true);

    const failing = createDemoCaller("error", now, 0);
    await expect(failing.callTool("get_vehicle_status", {})).resolves.toBeDefined();
    await expect(failing.callTool("list_routes", period)).resolves.toBeDefined();
    await expect(failing.callTool("list_routes", period)).rejects.toBeInstanceOf(ToolCallError);
  });

  it("waits before answering when asked to, so loading states can be seen", async () => {
    const started = Date.now();
    await createDemoCaller("commuter", started, 40).callTool("get_vehicle_status", {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});

describe("error text", () => {
  it("gives each step its own sentence and a code that can be copied", () => {
    expect(errorText(new LoadError("routes", "tool_error", "period_too_large"))).toEqual({
      title: "No se han podido cargar las rutas.",
      explanation: "El servicio ha respondido con un error.",
      code: "routes/tool_error (period_too_large)",
      action: "retry",
    });
    expect(errorText(new LoadError("status", "unexpected_shape", "get_vehicle_status.battery")).code).toBe(
      "status/unexpected_shape (get_vehicle_status.battery)",
    );
    expect(errorText(new LoadError("detail", "unknown", null)).code).toBe("detail/unknown");
    const titles = (["login", "status", "details", "routes", "detail"] as const).map((step) => errorText(new LoadError(step, "unknown", null)).title);
    expect(new Set(titles).size).toBe(5);
    const kinds = (["tool_error", "unexpected_shape", "too_many_routes", "unknown"] as const).map(
      (kind) => errorText(new LoadError("routes", kind, null)).explanation,
    );
    expect(new Set(kinds).size).toBe(4);
  });
});

describe("share card", () => {
  const list = rides([
    { start: "2026-04-10T09:00:00-07:00", km: 80.44, minutes: 90 },
    { start: "2026-07-04T09:00:00-07:00", km: 70, minutes: 60 },
    { start: "2026-07-05T09:00:00-07:00", km: 1070, minutes: 600 },
  ]);

  it("carries five figures and no dates of single rides", () => {
    const card = cardContent(list, 2026, false);
    expect(card.title).toBe("Tu 2026 en moto");
    expect(card.items).toEqual([
      { label: "Kilómetros", value: "1.220\u00A0km" },
      { label: "Salidas", value: "3" },
      { label: "Horas en marcha", value: "13\u00A0h" },
      { label: "Ruta más larga", value: "1.070,0\u00A0km" },
      { label: "Mes con más km", value: "julio · 1.140\u00A0km" },
    ]);
    expect(card.fileName).toBe("ride-log-2026.png");
    expect(cardText(card)).toBe(
      "Tu 2026 en moto. Kilómetros: 1.220\u00A0km; Salidas: 3; Horas en marcha: 13\u00A0h; Ruta más larga: 1.070,0\u00A0km; Mes con más km: julio · 1.140\u00A0km.",
    );
    expect(cardText(card)).not.toMatch(/\d{1,2} (abr|jul)/);
  });

  it("marks synthetic figures, names the year of the best month over the whole history and copes with no rides", () => {
    const demo = cardContent(list, "all", true);
    expect(demo.title).toBe("Tu historial en moto");
    expect(demo.items[4]?.value).toBe("julio de 2026 · 1.140\u00A0km");
    expect(demo.fileName).toBe("ride-log-historial-demo.png");
    expect(cardText(demo)).toContain("(datos de ejemplo)");
    const none = cardContent([], 2026, false);
    expect(none.items.map((item) => item.value)).toEqual(["0\u00A0km", "0", "0\u00A0h", "—", "—"]);
  });
});

describe("selectRoutes", () => {
  const list = rides([
    { start: "2026-03-07T10:00:00-08:00", km: 30 },
    { start: "2026-03-14T10:00:00-07:00", km: 10 },
    { start: "2026-04-01T10:00:00-07:00", km: 30 },
    { start: "2025-03-01T10:00:00-08:00", km: 50 },
  ]);
  const kms = (routes: readonly { distanceKm: number; startMs: number }[]): string[] =>
    routes.map((route) => `${new Date(route.startMs).toISOString().slice(0, 10)}:${route.distanceKm}`);

  it("orders by date or by distance, breaking distance ties by date", () => {
    expect(kms(selectRoutes(list, "", "date_desc"))).toEqual(["2026-04-01:30", "2026-03-14:10", "2026-03-07:30", "2025-03-01:50"]);
    expect(kms(selectRoutes(list, "", "date_asc"))).toEqual(["2025-03-01:50", "2026-03-07:30", "2026-03-14:10", "2026-04-01:30"]);
    expect(kms(selectRoutes(list, "", "km_desc"))).toEqual(["2025-03-01:50", "2026-04-01:30", "2026-03-07:30", "2026-03-14:10"]);
    expect(kms(selectRoutes(list, "", "km_asc"))).toEqual(["2026-03-14:10", "2026-03-07:30", "2026-04-01:30", "2025-03-01:50"]);
  });

  it("orders by maximum speed, fastest first, a tie oldest first and an unknown one last", () => {
    const fast = rides([
      { start: "2026-03-07T10:00:00-08:00", km: 1, maxSpeed: 80 },
      { start: "2026-03-08T10:00:00-07:00", km: 2, maxSpeed: null },
      { start: "2026-03-09T10:00:00-07:00", km: 3, maxSpeed: 95 },
      { start: "2026-03-10T10:00:00-07:00", km: 4, maxSpeed: 80 },
      { start: "2026-03-11T10:00:00-07:00", km: 5, maxSpeed: 0 },
      { start: "2025-03-01T10:00:00-08:00", km: 6, maxSpeed: 80 },
    ]);
    const byKm = (routes: readonly { distanceKm: number }[]): number[] => routes.map((route) => route.distanceKm);
    expect(byKm(selectRoutes(fast, "", "max_speed_desc"))).toEqual([3, 6, 1, 4, 5, 2]);
    expect(byKm(selectRoutes(fast, "marzo 2026", "max_speed_desc"))).toEqual([3, 1, 4, 5, 2]);
  });

  it("filters by the date text and leaves the given list untouched", () => {
    expect(kms(selectRoutes(list, "marzo 2026", "date_asc"))).toEqual(["2026-03-07:30", "2026-03-14:10"]);
    expect(selectRoutes(list, "diciembre", "date_asc")).toEqual([]);
    expect(kms(list)).toEqual(["2025-03-01:50", "2026-03-07:30", "2026-03-14:10", "2026-04-01:30"]);
  });
});

describe("lint rules that guard storage", () => {
  const eslint = new ESLint();
  async function rules(code: string, filePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).map((message) => message.ruleId ?? "parse-error");
  }

  it("allow localStorage in the maintenance storage file and nowhere else", async () => {
    const code = 'export const x = localStorage.getItem("k");\nexport const y = window.localStorage;\n';
    expect(await rules(code, "src/storage/maintenance.ts")).toEqual([]);
    for (const file of ["src/storage/other.ts", "src/ui/summary.ts", "src/main.ts", "src/service/loader.ts", "src/domain/maintenance.ts"]) {
      expect(await rules(code, file)).toEqual(["no-restricted-globals", "no-restricted-properties"]);
    }
  }, 30_000);

  it("keep sessionStorage and HTML sinks banned even in that file", async () => {
    const code =
      'export const x = sessionStorage.getItem("k");\nexport const y = window.sessionStorage;\ndocument.body.innerHTML = "";\n';
    expect(await rules(code, "src/storage/maintenance.ts")).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
      "no-restricted-properties",
    ]);
  }, 30_000);
});

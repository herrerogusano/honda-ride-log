import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider, type SyntheticRider } from "../src/demo/generator";
import { MIN_ROUTE_KM } from "../src/domain/privacy";
import { trimTrace } from "../src/domain/trim";
import {
  MAX_PERIOD_DAYS,
  MAX_RETURNED_ROUTES,
  ToolCallError,
  type RawRouteList,
  type ToolArguments,
  type ToolCaller,
  type ToolName,
} from "../src/service/contract";
import {
  loadAllRoutes,
  loadRouteTrace,
  loadVehicleInfo,
  loadVehicleState,
  LoadError,
  MAX_HISTORY_YEARS,
} from "../src/service/loader";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const DAY_MS = 86_400_000;
const commuter = generateRider({ seed: 7, nowMs: NOW });
const heavy = generateRider({ seed: 11, nowMs: NOW, profile: "heavy" });

interface Recorded {
  readonly name: ToolName;
  readonly args: ToolArguments[ToolName];
}

/** Wraps a caller: records every call and how many ran at the same time. */
function spy(inner: ToolCaller, change?: (name: ToolName, result: unknown) => unknown) {
  const calls: Recorded[] = [];
  let running = 0;
  let maxRunning = 0;
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        // Yield, so overlapping calls would be seen as overlapping.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await inner.callTool(name, args);
        return change ? change(name, result) : result;
      } finally {
        running -= 1;
      }
    },
  };
  return { caller, calls, maxRunning: () => maxRunning };
}

const periods = (calls: Recorded[]): ToolArguments["list_routes"][] =>
  calls.filter((call) => call.name === "list_routes").map((call) => call.args as ToolArguments["list_routes"]);

const starts = (rider: SyntheticRider): number[] => rider.routes.map((route) => Date.parse(route.started_at as string));

async function failure(promise: Promise<unknown>): Promise<LoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error("expected a LoadError");
}

const failing = (error: unknown): ToolCaller => ({
  async callTool() {
    throw error;
  },
});

describe("loadAllRoutes", () => {
  it("reads the whole history by semesters, newest first, and stops after an empty year", async () => {
    const { caller, calls } = spy(createDemoService(commuter));
    const load = await loadAllRoutes(caller, NOW);
    expect(load.routes.map((route) => route.startMs)).toEqual(starts(commuter));
    expect(load.skipped).toBe(0);
    // History starts in June 2024: three years with routes and then 2023, empty.
    expect(new Date(starts(commuter)[0] as number).getUTCFullYear()).toBe(2024);
    expect(periods(calls)).toEqual([
      { from_time: "2026-07-01T00:00:00.000Z", to_time: "2027-01-01T00:00:00.000Z" },
      { from_time: "2026-01-01T00:00:00.000Z", to_time: "2026-07-01T00:00:00.000Z" },
      { from_time: "2025-07-01T00:00:00.000Z", to_time: "2026-01-01T00:00:00.000Z" },
      { from_time: "2025-01-01T00:00:00.000Z", to_time: "2025-07-01T00:00:00.000Z" },
      { from_time: "2024-07-01T00:00:00.000Z", to_time: "2025-01-01T00:00:00.000Z" },
      { from_time: "2024-01-01T00:00:00.000Z", to_time: "2024-07-01T00:00:00.000Z" },
      { from_time: "2023-07-01T00:00:00.000Z", to_time: "2024-01-01T00:00:00.000Z" },
      { from_time: "2023-01-01T00:00:00.000Z", to_time: "2023-07-01T00:00:00.000Z" },
    ]);
    expect(load.requests).toBe(8);
  });

  it("recovers every route when a semester is cut at the limit", async () => {
    const { caller, calls } = spy(createDemoService(heavy));
    const load = await loadAllRoutes(caller, NOW);
    expect(heavy.routes.length).toBeGreaterThan(2 * MAX_RETURNED_ROUTES);
    expect(load.routes.map((route) => route.startMs)).toEqual(starts(heavy));
    // More requests than the six semesters a quiet rider would need.
    expect(load.requests).toBeGreaterThan(6);
    expect(load.requests).toBe(periods(calls).length);
  });

  it("makes one request at a time and never asks for more than the allowed period", async () => {
    const { caller, calls, maxRunning } = spy(createDemoService(heavy));
    await loadAllRoutes(caller, NOW);
    expect(maxRunning()).toBe(1);
    for (const period of periods(calls)) {
      expect(period.from_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(period.to_time).toMatch(/Z$/);
      const days = (Date.parse(period.to_time) - Date.parse(period.from_time)) / DAY_MS;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(MAX_PERIOD_DAYS);
    }
  });

  it("does not ask for a semester that has not started", async () => {
    const { caller, calls } = spy(createDemoService(commuter));
    await loadAllRoutes(caller, Date.parse("2026-03-10T08:00:00.000Z"));
    expect(periods(calls)[0]).toEqual({ from_time: "2026-01-01T00:00:00.000Z", to_time: "2026-07-01T00:00:00.000Z" });
  });

  it("keeps looking when the current year has no ride yet", async () => {
    const old = generateRider({ seed: 3, nowMs: Date.parse("2025-10-01T12:00:00.000Z") });
    const load = await loadAllRoutes(createDemoService(old), Date.parse("2026-03-01T12:00:00.000Z"));
    expect(load.routes.length).toBe(old.routes.length);
    expect(load.routes.length).toBeGreaterThan(100);
  });

  it("stops at a whole past year without routes, even if older ones exist (known limit)", async () => {
    const old = generateRider({ seed: 3, nowMs: Date.parse("2025-10-01T12:00:00.000Z") });
    const { caller, calls } = spy(createDemoService(old));
    const load = await loadAllRoutes(caller, Date.parse("2027-03-01T12:00:00.000Z"));
    expect(load.routes).toEqual([]);
    expect(periods(calls).map((period) => period.from_time.slice(0, 10))).toEqual([
      "2027-01-01",
      "2026-07-01",
      "2026-01-01",
    ]);
  });

  it("answers an account without routes after looking at this year and the last", async () => {
    const empty: ToolCaller = {
      async callTool(name, args) {
        const result = (await createDemoService(commuter).callTool(name, args)) as RawRouteList;
        return { ...result, routes: [], matched_routes: 0, returned_routes: 0, truncated: false };
      },
    };
    const load = await loadAllRoutes(empty, NOW);
    expect(load).toEqual({ routes: [], skipped: 0, requests: 4 });
  });

  it("counts a route once when two answers repeat it", async () => {
    const service = createDemoService(commuter);
    const extra = commuter.routes[commuter.routes.length - 1];
    const { caller } = spy(service, (name, result) => {
      if (name !== "list_routes") return result;
      const list = result as RawRouteList;
      // Every answer also carries the rider's last route, wherever it belongs.
      return { ...list, routes: [...list.routes, extra], matched_routes: list.matched_routes + 1 };
    });
    const load = await loadAllRoutes(caller, NOW);
    expect(load.routes.length).toBe(commuter.routes.length);
  });

  it("adds up the routes the sanitizer had to leave out, without counting cut answers twice", async () => {
    let broken = 0;
    const { caller } = spy(createDemoService(heavy), (name, result) => {
      if (name !== "list_routes") return result;
      const list = result as RawRouteList;
      if (list.truncated) {
        // A cut answer is thrown away: what it breaks must not be counted.
        return { ...list, routes: list.routes.map((route) => ({ ...route, started_at: null })) };
      }
      return {
        ...list,
        routes: list.routes.map((route, index) => {
          if (index % 50 !== 0) return route;
          broken += 1;
          return { ...route, distance_km: null };
        }),
      };
    });
    const load = await loadAllRoutes(caller, NOW);
    expect(broken).toBeGreaterThan(10);
    expect(load.skipped).toBe(broken);
    expect(load.routes.length).toBe(heavy.routes.length - broken);
  });

  it("does not let a year with only unusable routes end the search", async () => {
    const { caller } = spy(createDemoService(commuter), (name, result) => {
      if (name !== "list_routes") return result;
      const list = result as RawRouteList;
      if (!list.from_time.startsWith("2025")) return list;
      return { ...list, routes: list.routes.map((route) => ({ ...route, started_at: null })) };
    });
    const load = await loadAllRoutes(caller, NOW);
    const in2024 = starts(commuter).filter((ms) => new Date(ms).getUTCFullYear() === 2024).length;
    expect(in2024).toBeGreaterThan(0);
    expect(load.routes.filter((route) => new Date(route.startMs).getUTCFullYear() === 2024).length).toBe(in2024);
  });

  it("gives up with its own code if halving a period never ends the truncation", async () => {
    let requests = 0;
    const endless: ToolCaller = {
      async callTool(name, args) {
        requests += 1;
        const result = (await createDemoService(commuter).callTool(name, args)) as RawRouteList;
        return { ...result, routes: [], returned_routes: 0, matched_routes: 9999, truncated: true };
      },
    };
    const error = await failure(loadAllRoutes(endless, NOW));
    expect([error.step, error.kind, error.detail]).toEqual(["routes", "too_many_routes", null]);
    expect(requests).toBeLessThan(60);
  });

  it("never looks further back than the history limit", async () => {
    let requests = 0;
    const endlessHistory: ToolCaller = {
      async callTool(_name, args) {
        requests += 1;
        const period = args as ToolArguments["list_routes"];
        const route = { ...commuter.routes[0], route_id: `rt-DEMO-${requests}`, started_at: period.from_time };
        return { routes: [route], matched_routes: 1, returned_routes: 1, truncated: false };
      },
    };
    const load = await loadAllRoutes(endlessHistory, NOW);
    expect(MAX_HISTORY_YEARS).toBe(30);
    expect(requests).toBe(2 * MAX_HISTORY_YEARS);
    expect(load.routes.length).toBe(2 * MAX_HISTORY_YEARS);
  });

  it("reports progress with the number of routes loaded so far", async () => {
    const seen: number[] = [];
    const years: number[] = [];
    const load = await loadAllRoutes(createDemoService(commuter), NOW, (progress) => {
      seen.push(progress.loaded);
      years.push(progress.year);
    });
    expect(seen[0]).toBe(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(Math.max(...seen)).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(load.routes.length);
    expect(years[0]).toBe(2026);
    expect(years[years.length - 1]).toBe(2023);
  });

  it("still hands over routes under 300 m: hiding them is the caller's rule", async () => {
    const load = await loadAllRoutes(createDemoService(commuter), NOW);
    expect(load.routes.some((route) => route.distanceKm < MIN_ROUTE_KM)).toBe(true);
  });
});

describe("load errors", () => {
  it("names the step and the service's error code", async () => {
    const error = await failure(loadAllRoutes(failing(new ToolCallError("period_too_large", "a period may not exceed 366 days")), NOW));
    expect([error.step, error.kind, error.detail]).toEqual(["routes", "tool_error", "period_too_large"]);
    const status = await failure(loadVehicleState(failing(new ToolCallError("upstream_unavailable", "x"))));
    expect([status.step, status.kind, status.detail]).toEqual(["status", "tool_error", "upstream_unavailable"]);
    const details = await failure(loadVehicleInfo(failing(new ToolCallError("tool_error", "x"))));
    expect([details.step, details.kind, details.detail]).toEqual(["details", "tool_error", "tool_error"]);
  });

  it("does not repeat a service code that does not look like a code", async () => {
    const error = await failure(loadVehicleState(failing(new ToolCallError("Bearer abc.def.ghi", "token eyJhbGciOi"))));
    expect([error.step, error.kind, error.detail]).toEqual(["status", "tool_error", null]);
    expect(error.message).not.toMatch(/Bearer|eyJ/);
  });

  it("reports an unexpected shape with the field path and no value", async () => {
    const odd: ToolCaller = {
      async callTool() {
        return { battery: "SECRET-VALUE" };
      },
    };
    const error = await failure(loadVehicleState(odd));
    expect([error.step, error.kind, error.detail]).toEqual(["status", "unexpected_shape", "get_vehicle_status.battery"]);
    expect(error.message).not.toContain("SECRET-VALUE");
    const list = await failure(loadAllRoutes(odd, NOW));
    expect([list.step, list.kind, list.detail]).toEqual(["routes", "unexpected_shape", "list_routes.routes"]);
  });

  it("keeps only the class name of an unknown error, never its message", async () => {
    const error = await failure(loadVehicleInfo(failing(new TypeError("Failed to fetch https://example.invalid/?token=abc"))));
    expect([error.step, error.kind, error.detail]).toEqual(["details", "unknown", "TypeError"]);
    expect(error.message).not.toMatch(/token|example/);
    const thrownText = await failure(loadVehicleInfo(failing("a string with data")));
    expect([thrownText.kind, thrownText.detail]).toEqual(["unknown", null]);
  });
});

describe("vehicle and route detail", () => {
  it("loads the sanitized state and info", async () => {
    const service = createDemoService(commuter);
    const state = await loadVehicleState(service);
    expect(state.batteryPercent).toBe(commuter.status.battery);
    expect(state.odometer).toBe(commuter.status.odometer);
    expect(Object.keys(state).sort()).toEqual(["batteryPercent", "lastCommunicationMs", "odometer", "status"]);
    expect(await loadVehicleInfo(service)).toEqual({ model: "Demo 125", mileage: commuter.details.mileage });
  });

  it("asks for the detail of the chosen route only, and the result can be trimmed", async () => {
    const service = createDemoService(commuter);
    const { caller, calls } = spy(service);
    const load = await loadAllRoutes(caller, NOW);
    expect(calls.every((call) => call.name === "list_routes")).toBe(true);
    const longest = load.routes.reduce((a, b) => (b.distanceKm > a.distanceKm ? b : a));
    const expectedId = commuter.routes.reduce((a, b) => ((b.distance_km ?? 0) > (a.distance_km ?? 0) ? b : a)).route_id;
    const trace = await loadRouteTrace(caller, longest.ref);
    expect(calls[calls.length - 1]).toEqual({ name: "get_route_detail", args: { route_id: expectedId } });
    expect(Object.keys(trace)).toEqual([]);
    expect(trimTrace(trace).lines.length).toBeGreaterThan(0);
  });

  it("reports a failed detail with its own step", async () => {
    const load = await loadAllRoutes(createDemoService(commuter), NOW);
    const ref = load.routes[0]?.ref;
    if (ref === undefined) throw new Error("no route");
    const other = createDemoService(generateRider({ seed: 99, nowMs: NOW }));
    const error = await failure(loadRouteTrace(other, ref));
    expect([error.step, error.kind, error.detail]).toEqual(["detail", "tool_error", "tool_error"]);
  });
});

import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider, type SyntheticRider } from "../src/demo/generator";
import { ToolCallError, type RawRouteList, type RawRouteSummary, type ToolArguments, type ToolCaller } from "../src/service/contract";
import { loadAllRoutes, loadVehicleState, LoadError } from "../src/service/loader";

/** Boundaries of the loader an independent review found without a test. */
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const commuter = generateRider({ seed: 7, nowMs: NOW });

function recording(inner: ToolCaller): { caller: ToolCaller; periods: ToolArguments["list_routes"][] } {
  const periods: ToolArguments["list_routes"][] = [];
  return {
    periods,
    caller: {
      async callTool(name, args) {
        if (name === "list_routes") periods.push(args as ToolArguments["list_routes"]);
        return inner.callTool(name, args);
      },
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<LoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error("expected a LoadError");
}

/** A rider with exactly these routes, behind the demo service and its limits. */
function riderWith(routes: RawRouteSummary[]): SyntheticRider {
  return { status: commuter.status, details: commuter.details, routes, detail: () => undefined };
}

function routeAt(ms: number, id: string): RawRouteSummary {
  return { ...(commuter.routes[0] as RawRouteSummary), route_id: id, started_at: new Date(ms).toISOString(), ended_at: new Date(ms + 60_000).toISOString() };
}

describe("loader boundaries", () => {
  it("keeps going past a year that only has rides in its second half", async () => {
    const onlySecondHalf: ToolCaller = {
      async callTool(name, args) {
        const answer = await createDemoService(commuter).callTool(name, args);
        if (name !== "list_routes") return answer;
        const list = answer as RawRouteList;
        // 2025 loses every ride from January to June.
        if (list.from_time.startsWith("2025-01-01")) return { ...list, routes: [], matched_routes: 0, returned_routes: 0 };
        return list;
      },
    };
    const load = await loadAllRoutes(onlySecondHalf, NOW);
    const years = new Set(load.routes.map((route) => new Date(route.startMs).getUTCFullYear()));
    expect([...years].sort()).toEqual([2024, 2025, 2026]);
  });

  it("does not lose a ride that starts at the very instant a cut period is split", async () => {
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2026, 6, 1);
    const middle = Math.floor((from + to) / 2);
    // 600 rides in one semester (more than one answer holds), one of them exactly at the split.
    const routes = Array.from({ length: 600 }, (_, index) => routeAt(index === 300 ? middle : from + (index + 1) * 20_000_000, `rt-DEMO-split-${index}`));
    routes.sort((a, b) => Date.parse(a.started_at as string) - Date.parse(b.started_at as string));
    const load = await loadAllRoutes(createDemoService(riderWith(routes)), NOW);
    expect(load.routes.length).toBe(600);
    expect(load.routes.filter((route) => route.startMs === middle).length).toBe(1);
    expect(load.requests).toBeGreaterThan(4);
  });

  it("takes the current year from UTC, like the semesters it asks for", async () => {
    // 03:00 UTC on 1 January 2027 is still 2026 in Los Angeles, where the tests run.
    const { caller, periods } = recording(createDemoService(commuter));
    await loadAllRoutes(caller, Date.parse("2027-01-01T03:00:00.000Z"));
    expect(periods[0]).toEqual({ from_time: "2027-01-01T00:00:00.000Z", to_time: "2027-07-01T00:00:00.000Z" });
  });

  it("asks for the second semester from its very first instant", async () => {
    const { caller, periods } = recording(createDemoService(commuter));
    await loadAllRoutes(caller, Date.UTC(2026, 6, 1));
    expect(periods[0]).toEqual({ from_time: "2026-07-01T00:00:00.000Z", to_time: "2027-01-01T00:00:00.000Z" });
    const before = recording(createDemoService(commuter));
    await loadAllRoutes(before.caller, Date.UTC(2026, 6, 1) - 1);
    expect(before.periods[0]?.from_time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports progress before each of the two semesters of a year", async () => {
    const seen: string[] = [];
    await loadAllRoutes(createDemoService(commuter), NOW, (progress) => seen.push(`${progress.year}:${progress.loaded > 0}`));
    expect(seen.length).toBe(8);
    expect(seen.slice(0, 3)).toEqual(["2026:false", "2026:true", "2025:true"]);
    expect(seen.filter((entry) => entry.startsWith("2023")).length).toBe(2);
  });

  it("refuses a clock that is not a number instead of answering with no routes", async () => {
    let calls = 0;
    const counting: ToolCaller = {
      async callTool(name, args) {
        calls += 1;
        return createDemoService(commuter).callTool(name, args);
      },
    };
    const error = await failure(loadAllRoutes(counting, Number.NaN));
    expect([error.step, error.kind, error.detail]).toEqual(["routes", "unknown", "InvalidClock"]);
    expect(calls).toBe(0);
    // A number no calendar can hold is no clock either.
    for (const clock of [9e15, -9e15, Number.POSITIVE_INFINITY]) {
      const outOfRange = await failure(loadAllRoutes(counting, clock));
      expect([outOfRange.step, outOfRange.kind, outOfRange.detail], String(clock)).toEqual(["routes", "unknown", "InvalidClock"]);
    }
    expect(calls).toBe(0);
  });
});

describe("what a load error may show", () => {
  const failing = (error: unknown): ToolCaller => ({
    async callTool() {
      throw error;
    },
  });

  it("drops service codes that are not plain lower-case codes", async () => {
    for (const code of ["AbC.def", "eyJhbGciOiJIUzI1NiJ9.payload", "Period_Too_Large", "with space", "x".repeat(65), "", "9lives", "semi;colon"]) {
      const error = await failure(loadVehicleState(failing(new ToolCallError(code, "x"))));
      expect([error.kind, error.detail], code).toEqual(["tool_error", null]);
      expect(error.message).toBe("load failed at status: tool_error");
    }
    const kept = await failure(loadVehicleState(failing(new ToolCallError("upstream_unavailable_2", "x"))));
    expect(kept.detail).toBe("upstream_unavailable_2");
    expect(kept.message).toBe("load failed at status: tool_error (upstream_unavailable_2)");
  });

  it("drops exception names that are not plain class names", async () => {
    for (const name of ["not a name!", "Type.Error", "a/b", "", "x".repeat(65), "https://example.invalid"]) {
      const odd = new Error("private");
      odd.name = name;
      const error = await failure(loadVehicleState(failing(odd)));
      expect([error.kind, error.detail], name).toEqual(["unknown", null]);
      expect(error.message).toBe("load failed at status: unknown");
    }
  });

  it("keeps no reference to the original error", async () => {
    const error = await failure(loadVehicleState(failing(new TypeError("private text"))));
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(Object.entries(error))).not.toContain("private");
  });
});

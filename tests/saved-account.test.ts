// The account data kept in the tab (docs/PLAN.md, section 10, «Los datos de
// la cuenta»): the plain value src/domain/sanitize.ts makes and checks, its
// binding to the stored token in src/auth/savedSession.ts, and how the loader
// finds a kept route again without a stored id. All in memory, against the
// demo service: they prove the contract as we read it, not the real service
// nor a real browser's storage or quota.
import { describe, expect, it } from "vitest";
import {
  clearSavedSession,
  readSavedAccount,
  readSavedSession,
  readVehicleChoice,
  saveAccount,
  saveSession,
  saveVehicleChoice,
  type TokenStorage,
} from "../src/auth/savedSession";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import type { AccountData } from "../src/domain/model";
import { accountSnapshot, needsRouteLookup, restoreAccount, serviceRouteId, ShapeError } from "../src/domain/sanitize";
import type { RawRouteList, ToolCaller } from "../src/service/contract";
import { LoadError, loadAllRoutes, loadRouteTrace, loadVehicleInfo, loadVehicleState, routeLookupReads } from "../src/service/loader";

class MemoryStorage implements TokenStorage {
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

const NOW = Date.parse("2026-07-01T10:00:00Z");
const TOKEN = "SyntheticAccessTokenValue0001";
const EXPIRES = NOW + 3_600_000;
/** Two synthetic bindings, as `randomToken` makes them (43 base64url characters). */
const BINDING = "A".repeat(42) + "1";
const OTHER_BINDING = "B".repeat(42) + "2";
const rider = generateRider({ seed: 7, nowMs: NOW });

async function accountOf(caller: ToolCaller): Promise<AccountData> {
  const load = await loadAllRoutes(caller, NOW);
  return { vehicle: await loadVehicleState(caller), info: await loadVehicleInfo(caller), routes: load.routes, skipped: load.skipped };
}

/** The value as it goes through the tab: a JSON round trip. */
const throughTab = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** Every call to the caller, by tool and arguments. */
function spy(caller: ToolCaller): { caller: ToolCaller; calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    caller: {
      callTool: (name, args) => {
        calls.push({ name, args });
        return caller.callTool(name, args);
      },
    },
  };
}

describe("the value kept in the tab", () => {
  it("comes back with the same figures, and its routes with refs that have no id behind them", async () => {
    const data = await accountOf(createDemoService(rider));
    const back = restoreAccount(throughTab(accountSnapshot(data)));
    const fields = (one: AccountData) => ({
      ...one,
      routes: one.routes.map((route) => [route.startMs, route.endMs, route.durationS, route.distanceKm, route.averageSpeed, route.maxSpeed, route.hasInferredSegments]),
    });
    expect(fields(back)).toEqual(fields(data));
    expect(back.routes.length).toBe(data.routes.length);
    for (const route of back.routes) {
      expect(needsRouteLookup(route.ref)).toBe(true);
      expect(() => serviceRouteId(route.ref)).toThrow(ShapeError);
    }
    for (const route of data.routes) expect(needsRouteLookup(route.ref)).toBe(false);
  });

  it("holds no route id and no field outside its closed list", async () => {
    const data = await accountOf(createDemoService(rider));
    const text = JSON.stringify(accountSnapshot(data));
    for (const route of rider.routes) expect(text).not.toContain(route.route_id);
    for (const word of ["route_id", "registration", "vin", "dealer", "position", "geojson", "timezone", "odometer_start"]) expect(text).not.toContain(word);
    const value = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(["info", "routes", "skipped", "v", "vehicle"]);
  });

  it.each([
    ["no object", null],
    ["another version", { v: 2, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [] }],
    ["a route with a text start", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [["x", null, 1, null, null, null]] }],
    ["a route ending before it starts", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[1000, 10, 1, null, null, null]] }],
    ["a negative distance", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[1000, null, -1, null, null, null]] }],
    ["a route with a seventh field", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[1000, null, 1, null, null, null, "id"]] }],
    ["a battery of 300 %", { v: 1, vehicle: [null, "300", null, null], info: null, skipped: 0, routes: [] }],
    ["a negative count", { v: 1, vehicle: [null, null, null, null], info: null, skipped: -1, routes: [] }],
    ["an end no date can hold", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[1000, 1e100, 1, null, null, null]] }],
    ["a start no date can hold", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[9e15, null, 1, null, null, null]] }],
    ["a start between milliseconds", { v: 1, vehicle: [null, null, null, null], info: null, skipped: 0, routes: [[1000.5, null, 1, null, null, null]] }],
    ["a last communication no date can hold", { v: 1, vehicle: [null, null, 1e100, null], info: null, skipped: 0, routes: [] }],
  ])("is refused when damaged (%s)", (_name, value) => {
    expect(() => restoreAccount(value)).toThrow(ShapeError);
  });

  it("fits the tab with the big demo (about 1,500 routes), measured", async () => {
    const heavy = generateRider({ seed: 2026, nowMs: NOW, profile: "heavy" });
    const data = await accountOf(createDemoService(heavy));
    const size = JSON.stringify({ binding: BINDING, account: accountSnapshot(data) }).length;
    // Measured on this demo when written: see docs/PLAN.md, section 10, «Los datos de la cuenta».
    if (process.env["MEASURE_SAVED"] === "1") process.stdout.write(`MEASURE ${data.routes.length} routes, ${size} characters
`);
    expect(data.routes.length).toBeGreaterThan(1_000);
    // Browsers give a tab about 5 million characters of sessionStorage.
    expect(size).toBeLessThan(250_000);
  });
});

describe("the motorbike chosen in the tab (docs/PLAN.md, section 19)", () => {
  it("is kept and handed back only for the token stored with its binding", () => {
    const tab = new MemoryStorage();
    expect(saveVehicleChoice(tab, BINDING, "veh-DEMO-0002", NOW)).toBe(false);
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
    expect(saveVehicleChoice(tab, BINDING, "veh-DEMO-0002", NOW)).toBe(true);
    expect(JSON.parse(tab.items.get("ride-log.vehicle") ?? "{}")).toEqual({ binding: BINDING, vehicle: "veh-DEMO-0002" });
    expect(readVehicleChoice(tab, BINDING, NOW)).toBe("veh-DEMO-0002");
    // Another session's choice under this token: removed.
    expect(readVehicleChoice(tab, OTHER_BINDING, NOW)).toBeNull();
    expect(tab.items.has("ride-log.vehicle")).toBe(false);
    saveVehicleChoice(tab, BINDING, "veh-DEMO-0002", NOW);
    expect(saveVehicleChoice(tab, BINDING, null, NOW)).toBe(false);
    expect(tab.items.has("ride-log.vehicle")).toBe(false);
  });

  it("goes with the token: at sign-out, at a new sign-in, with an expired or damaged token", () => {
    const tab = new MemoryStorage();
    const fill = (): void => {
      saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
      saveVehicleChoice(tab, BINDING, "veh-DEMO-0001", NOW);
      expect(tab.items.has("ride-log.vehicle")).toBe(true);
    };
    fill();
    clearSavedSession(tab);
    expect(tab.items.size).toBe(0);
    fill();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: OTHER_BINDING });
    expect(tab.items.has("ride-log.vehicle")).toBe(false);
    fill();
    expect(readSavedSession(tab, EXPIRES)).toBeNull();
    expect(tab.items.size).toBe(0);
    fill();
    tab.setItem("ride-log.session", "{");
    expect(readSavedSession(tab, NOW)).toBeNull();
    expect(tab.items.size).toBe(0);
  });

  it("drops a damaged entry and refuses an id the service would refuse", () => {
    const tab = new MemoryStorage();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
    for (const bad of ["{", JSON.stringify({ binding: BINDING, vehicle: 7 }), JSON.stringify({ binding: BINDING, vehicle: "" }), JSON.stringify({ binding: BINDING, vehicle: "v".repeat(257) })]) {
      tab.setItem("ride-log.vehicle", bad);
      expect(readVehicleChoice(tab, BINDING, NOW)).toBeNull();
      expect(tab.items.has("ride-log.vehicle")).toBe(false);
    }
    expect(() => saveVehicleChoice(tab, BINDING, "v".repeat(257), NOW)).toThrow(TypeError);
  });
});

describe("the binding to the stored token", () => {
  it("hands the data back only with that same token stored", () => {
    const tab = new MemoryStorage();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
    expect(saveAccount(tab, BINDING, { v: 1 }, NOW)).toBe(true);
    expect(readSavedAccount(tab, BINDING, NOW)).toEqual({ v: 1 });
    // Kept for another token: removed.
    tab.setItem("ride-log.account", JSON.stringify({ binding: OTHER_BINDING, account: { v: 1 } }));
    expect(readSavedAccount(tab, BINDING, NOW)).toBeNull();
    expect(tab.items.has("ride-log.account")).toBe(false);
  });

  it("refuses another session's data put under this token, even with the very same expiry", () => {
    const tab = new MemoryStorage();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: OTHER_BINDING });
    saveAccount(tab, OTHER_BINDING, { v: 1 }, NOW);
    const foreign = tab.items.get("ride-log.account") ?? "";
    saveSession(tab, { accessToken: "SyntheticAccessTokenValue0002", expiresAtMs: EXPIRES, binding: BINDING });
    tab.setItem("ride-log.account", foreign);
    expect(readSavedAccount(tab, BINDING, NOW)).toBeNull();
    expect(tab.items.has("ride-log.account")).toBe(false);
    // Nor is it handed to the first session, whose token is no longer the stored one.
    tab.setItem("ride-log.account", foreign);
    expect(readSavedAccount(tab, OTHER_BINDING, NOW)).toBeNull();
    expect(saveAccount(tab, OTHER_BINDING, { v: 1 }, NOW)).toBe(false);
    expect(tab.items.has("ride-log.account")).toBe(false);
  });

  it("keeps nothing for a token saved without a binding (an older page), and its token still works", () => {
    const tab = new MemoryStorage();
    tab.setItem("ride-log.session", JSON.stringify({ token: TOKEN, expiresAt: EXPIRES }));
    tab.setItem("ride-log.account", JSON.stringify({ expiresAt: EXPIRES, account: { v: 1 } }));
    expect(readSavedSession(tab, NOW)).toEqual({ accessToken: TOKEN, expiresAtMs: EXPIRES, binding: null });
    expect(tab.items.has("ride-log.account")).toBe(false);
    expect(saveAccount(tab, BINDING, { v: 1 }, NOW)).toBe(false);
  });

  it("never saves a binding that is not one", () => {
    const tab = new MemoryStorage();
    for (const binding of ["", "short", `${BINDING}x`, BINDING.replace(/^./, "+")]) {
      expect(() => saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding })).toThrow(TypeError);
    }
    expect(tab.items.size).toBe(0);
  });

  it("keeps nothing for a token that is not the stored one", () => {
    const tab = new MemoryStorage();
    expect(saveAccount(tab, BINDING, { v: 1 }, NOW)).toBe(false);
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
    expect(saveAccount(tab, OTHER_BINDING, { v: 1 }, NOW)).toBe(false);
    expect(tab.items.has("ride-log.account")).toBe(false);
  });

  it("drops damaged data", () => {
    const tab = new MemoryStorage();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
    tab.setItem("ride-log.account", "{");
    expect(readSavedAccount(tab, BINDING, NOW)).toBeNull();
    expect(tab.items.has("ride-log.account")).toBe(false);
  });

  it("goes with the token: cleared, expired, damaged, missing or replaced by a new one", () => {
    const tab = new MemoryStorage();
    const fill = (): void => {
      saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES, binding: BINDING });
      saveAccount(tab, BINDING, { v: 1 }, NOW);
      expect(tab.items.size).toBe(2);
    };
    fill();
    clearSavedSession(tab);
    expect(tab.items.size).toBe(0);
    fill();
    expect(readSavedSession(tab, EXPIRES)).toBeNull();
    expect(tab.items.size).toBe(0);
    fill();
    tab.setItem("ride-log.session", "{");
    expect(readSavedAccount(tab, BINDING, NOW)).toBeNull();
    expect(tab.items.size).toBe(0);
    fill();
    tab.removeItem("ride-log.session");
    expect(readSavedAccount(tab, BINDING, NOW)).toBeNull();
    expect(tab.items.size).toBe(0);
    fill();
    saveSession(tab, { accessToken: TOKEN, expiresAtMs: EXPIRES + 5, binding: OTHER_BINDING });
    expect([...tab.items.keys()]).toEqual(["ride-log.session"]);
  });
});

/** The routes of the first UTC semester with at least eight of them. */
function busySemester(routes: AccountData["routes"]): AccountData["routes"] {
  const halves = new Map<string, AccountData["routes"][number][]>();
  for (const route of routes) {
    const date = new Date(route.startMs);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth() < 6 ? 1 : 2}`;
    halves.set(key, [...(halves.get(key) ?? []), route]);
  }
  const found = [...halves.values()].find((half) => half.length >= 8);
  if (found === undefined) throw new Error("no semester with eight routes");
  return found;
}

describe("a kept route found again for its trace", () => {
  it("costs one light read per semester, and asks for the detail of that very route", async () => {
    const data = await accountOf(createDemoService(rider));
    const back = restoreAccount(throughTab(accountSnapshot(data)));
    const { caller, calls } = spy(createDemoService(rider));
    // Two routes of the first half of 2026, the same semester.
    const inHalf = (one: { startMs: number }) => one.startMs >= Date.UTC(2026, 0, 1) && one.startMs < Date.UTC(2026, 6, 1);
    const [first, second] = back.routes.filter(inHalf).slice(-2) as [AccountData["routes"][number], AccountData["routes"][number]];
    const [freshFirst] = data.routes.filter(inHalf).slice(-2);
    // At most: the semester, and a narrow read for each route in case its answer is cut.
    expect(routeLookupReads(caller, [first, second])).toBe(3);
    await loadRouteTrace(caller, first);
    expect(routeLookupReads(caller, [first, second])).toBe(0);
    await loadRouteTrace(caller, second);
    expect(calls.map((call) => call.name)).toEqual(["list_routes", "get_route_detail", "get_route_detail"]);
    expect(calls[1]?.args).toEqual({ route_id: serviceRouteId((freshFirst ?? first).ref) });
    const range = calls[0]?.args as { from_time: string; to_time: string };
    expect(Date.parse(range.to_time) - Date.parse(range.from_time)).toBeGreaterThan(150 * 86_400_000);
  });

  it("falls back to a window of one millisecond when the semester is cut", async () => {
    const data = await accountOf(createDemoService(rider));
    const back = restoreAccount(throughTab(accountSnapshot(data)));
    const route = back.routes[back.routes.length - 1] as AccountData["routes"][number];
    const service = createDemoService(rider);
    const { caller, calls } = spy({
      async callTool(name, args) {
        const answer = await service.callTool(name, args);
        if (name !== "list_routes") return answer;
        const list = answer as RawRouteList;
        const range = args as { from_time: string; to_time: string };
        const wide = Date.parse(range.to_time) - Date.parse(range.from_time) > 1;
        return wide ? { ...list, truncated: true } : list;
      },
    });
    await loadRouteTrace(caller, route);
    expect(calls.map((call) => call.name)).toEqual(["list_routes", "list_routes", "get_route_detail"]);
    const narrow = calls[1]?.args as { from_time: string; to_time: string };
    expect([Date.parse(narrow.from_time), Date.parse(narrow.to_time)]).toEqual([route.startMs, route.startMs + 1]);
  });

  it("never says fewer reads than it makes, also when the semester is cut", async () => {
    const data = await accountOf(createDemoService(rider));
    const back = restoreAccount(throughTab(accountSnapshot(data)));
    // Eight routes of one semester.
    const eight = busySemester(back.routes).slice(-8);
    expect(eight).toHaveLength(8);
    const service = createDemoService(rider);
    const { caller, calls } = spy({
      async callTool(name, args) {
        const answer = await service.callTool(name, args);
        if (name !== "list_routes") return answer;
        const range = args as { from_time: string; to_time: string };
        return Date.parse(range.to_time) - Date.parse(range.from_time) > 1 ? { ...(answer as RawRouteList), truncated: true } : answer;
      },
    });
    const announced = routeLookupReads(caller, eight);
    for (const route of eight) await loadRouteTrace(caller, route);
    const made = calls.filter((call) => call.name === "list_routes").length;
    expect(made).toBe(9);
    expect(announced).toBeGreaterThanOrEqual(made);
    expect(routeLookupReads(caller, eight)).toBe(0);
  });

  it("is exact once the semester is known to be cut", async () => {
    const back = restoreAccount(throughTab(accountSnapshot(await accountOf(createDemoService(rider)))));
    const [before, last] = busySemester(back.routes).slice(-2) as [AccountData["routes"][number], AccountData["routes"][number]];
    const service = createDemoService(rider);
    const caller: ToolCaller = {
      async callTool(name, args) {
        const answer = await service.callTool(name, args);
        if (name !== "list_routes") return answer;
        const range = args as { from_time: string; to_time: string };
        return Date.parse(range.to_time) - Date.parse(range.from_time) > 1 ? { ...(answer as RawRouteList), truncated: true } : answer;
      },
    };
    await loadRouteTrace(caller, last);
    // Same semester, cut: only its own one-millisecond read is left.
    expect(routeLookupReads(caller, [before, last])).toBe(1);
  });

  it("says so, with its own code, when the route is no longer there or two are alike, and asks again next time", async () => {
    const back = restoreAccount(throughTab(accountSnapshot(await accountOf(createDemoService(rider)))));
    const route = back.routes[0] as AccountData["routes"][number];
    const gone = { ...route, distanceKm: route.distanceKm + 0.5 };
    const { caller, calls } = spy(createDemoService(rider));
    const error = await loadRouteTrace(caller, gone).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LoadError);
    expect([(error as LoadError).step, (error as LoadError).kind, (error as LoadError).detail]).toEqual(["detail", "unexpected_shape", "route_lookup"]);
    expect(calls.map((call) => call.name)).toEqual(["list_routes"]);

    const service = createDemoService(rider);
    let fail = true;
    const flaky = spy({
      async callTool(name, args) {
        if (name === "list_routes" && fail) throw new Error("down");
        const answer = await service.callTool(name, args);
        if (name !== "list_routes") return answer;
        // The same route twice: no way to tell which one is meant.
        const list = answer as RawRouteList;
        return { ...list, routes: [...list.routes, ...list.routes.map((one) => ({ ...one, route_id: `${one.route_id}b` }))], matched_routes: list.matched_routes * 2, returned_routes: list.returned_routes * 2 };
      },
    });
    await expect(loadRouteTrace(flaky.caller, route)).rejects.toBeInstanceOf(LoadError);
    fail = false;
    const twice = await loadRouteTrace(flaky.caller, route).catch((caught: unknown) => caught);
    expect((twice as LoadError).detail).toBe("route_lookup");
    // The failed read was not kept: it was asked again.
    expect(flaky.calls.map((call) => call.name)).toEqual(["list_routes", "list_routes"]);
  });
});

import { describe, expect, it } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { MAX_RETURNED_ROUTES, ToolCallError, type RawRouteList, type ToolCaller } from "../src/service/contract";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const heavy = generateRider({ seed: 11, nowMs: NOW, profile: "heavy" });

async function list(service: ToolCaller, from: string, to: string): Promise<RawRouteList> {
  return (await service.callTool("list_routes", { from_time: from, to_time: to })) as RawRouteList;
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolCallError) return error.code;
    throw error;
  }
  return "no error";
}

describe("demo service limits", () => {
  it("accepts a period of 366 days and rejects a longer one", async () => {
    const service = createDemoService(heavy);
    await expect(list(service, "2025-01-01", "2026-01-02")).resolves.toBeDefined();
    expect(await errorCode(list(service, "2025-01-01", "2026-01-03"))).toBe("period_too_large");
  });

  it("rejects reversed, empty and zone-less boundaries", async () => {
    const service = createDemoService(heavy);
    expect(await errorCode(list(service, "2026-02-01", "2026-01-01"))).toBe("invalid_date_range");
    expect(await errorCode(list(service, "2026-01-01", "2026-01-01"))).toBe("invalid_date_range");
    expect(await errorCode(list(service, "", "2026-01-01"))).toBe("invalid_date_range");
    expect(await errorCode(list(service, "2026-01-01T00:00:00", "2026-02-01T00:00:00"))).toBe("invalid_date_range");
    expect(await errorCode(list(service, "ayer", "hoy"))).toBe("invalid_date_range");
  });

  it("includes the start boundary and excludes the end boundary", async () => {
    const service = createDemoService(heavy);
    const target = heavy.routes[40];
    const startedAt = target?.started_at as string;
    const oneMsLater = new Date(Date.parse(startedAt) + 1).toISOString();
    const dayBefore = new Date(Date.parse(startedAt) - 86_400_000).toISOString();
    const fromStart = await list(service, startedAt, oneMsLater);
    expect(fromStart.routes.map((r) => r.route_id)).toEqual([target?.route_id]);
    const untilStart = await list(service, dayBefore, startedAt);
    expect(untilStart.routes.length).toBeGreaterThan(0);
    expect(untilStart.routes.map((r) => r.route_id)).not.toContain(target?.route_id);
  });

  it("cuts a busy semester at the limit and says so", async () => {
    const service = createDemoService(heavy);
    const page = await list(service, "2026-01-01", "2026-07-01");
    expect(page.truncated).toBe(true);
    expect(page.routes.length).toBe(MAX_RETURNED_ROUTES);
    expect(page.returned_routes).toBe(MAX_RETURNED_ROUTES);
    expect(page.matched_routes).toBeGreaterThan(MAX_RETURNED_ROUTES);
    // The first routes of the period are the ones returned.
    expect(page.routes[0]?.started_at?.slice(0, 7)).toBe("2026-01");
  });

  it("lets a caller recover every route by halving a truncated period", async () => {
    const service = createDemoService(heavy);
    async function all(fromMs: number, toMs: number): Promise<string[]> {
      const page = await list(service, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
      if (!page.truncated) return page.routes.map((r) => r.route_id);
      const middle = Math.floor((fromMs + toMs) / 2);
      return [...(await all(fromMs, middle)), ...(await all(middle, toMs))];
    }
    const from = Date.parse("2026-01-01T00:00:00Z");
    const to = Date.parse("2026-07-01T00:00:00Z");
    const expected = heavy.routes
      .filter((r) => Date.parse(r.started_at as string) >= from && Date.parse(r.started_at as string) < to)
      .map((r) => r.route_id);
    expect(expected.length).toBeGreaterThan(MAX_RETURNED_ROUTES);
    expect(await all(from, to)).toEqual(expected);
  });

  it("answers a quiet period without truncation", async () => {
    const page = await list(createDemoService(heavy), "2026-03-02", "2026-03-09");
    expect(page.truncated).toBe(false);
    expect(page.matched_routes).toBe(page.routes.length);
    expect(page.completeness).toBe("unverified");
  });

  it("serves status, details and one route detail, and rejects unknown ids", async () => {
    const service = createDemoService(heavy);
    expect(await service.callTool("get_vehicle_status", {})).toEqual(heavy.status);
    expect(await service.callTool("get_vehicle_details", {})).toEqual(heavy.details);
    const id = heavy.routes[3]?.route_id as string;
    expect(await service.callTool("get_route_detail", { route_id: id })).toEqual(heavy.detail(id));
    expect(await errorCode(service.callTool("get_route_detail", { route_id: "rt-unknown" }))).toBe("tool_error");
    expect(await errorCode(service.callTool("get_route_detail", { route_id: "" }))).toBe("invalid_route_id");
    expect(service.calls).toEqual([
      "get_vehicle_status",
      "get_vehicle_details",
      "get_route_detail",
      "get_route_detail",
      "get_route_detail",
    ]);
  });

  it("hands out copies, so a caller cannot change the data", async () => {
    const service = createDemoService(heavy);
    const original = heavy.status.battery;
    const first = (await service.callTool("get_vehicle_status", {})) as { battery: number };
    first.battery = -1;
    const second = (await service.callTool("get_vehicle_status", {})) as { battery: number };
    expect(second.battery).toBe(original);
    expect(heavy.status.battery).toBe(original);
  });
});

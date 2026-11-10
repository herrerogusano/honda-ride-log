/**
 * Loads a rider's data through a `ToolCaller`, without knowing whether the
 * demo service or the real `/mcp` client is behind it (docs/PLAN.md, "Carga
 * de datos"). One request at a time, never in parallel.
 *
 * Every answer goes through `src/domain/sanitize.ts` here, before anything
 * else can touch it. This is also the one place that opens a `RouteRef` to
 * ask for a route detail.
 */
import type { Route, RouteRef, UntrimmedTrace, VehicleInfo, VehicleState } from "../domain/model";
import {
  sanitizeRouteList,
  sanitizeRouteTrace,
  sanitizeVehicleDetails,
  sanitizeVehicleStatus,
  serviceRouteId,
  ShapeError,
} from "../domain/sanitize";
import { ToolCallError, type ToolCaller } from "./contract";

/** The step of the load that failed. Each one has its own visible error code. */
export type LoadStep = "status" | "details" | "routes" | "detail";

/**
 * What went wrong, in closed terms. Phase 3 adds the kinds only a real
 * client can produce (missing configuration, login, network, 401, 403).
 */
export type FailureKind = "tool_error" | "unexpected_shape" | "too_many_routes" | "unknown";

/**
 * A failed load step. `detail` is safe to show: the service's error code, the
 * field path of a shape error or the name of an exception class. It never
 * carries a message, a value, a token or an identifier.
 */
export class LoadError extends Error {
  readonly step: LoadStep;
  readonly kind: FailureKind;
  readonly detail: string | null;
  constructor(step: LoadStep, kind: FailureKind, detail: string | null) {
    super(`load failed at ${step}: ${kind}${detail === null ? "" : ` (${detail})`}`);
    this.name = "LoadError";
    this.step = step;
    this.kind = kind;
    this.detail = detail;
  }
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

function toLoadError(step: LoadStep, error: unknown): LoadError {
  if (error instanceof LoadError) return error;
  if (error instanceof ToolCallError) {
    // The code comes from the service: show it only if it looks like a code.
    return new LoadError(step, "tool_error", SAFE_CODE.test(error.code) ? error.code : null);
  }
  if (error instanceof ShapeError) return new LoadError(step, "unexpected_shape", error.path);
  // Messages of unknown errors may quote data or addresses: keep the class name only.
  const name = error instanceof Error ? error.name : "";
  return new LoadError(step, "unknown", SAFE_NAME.test(name) ? name : null);
}

async function step<T>(name: LoadStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toLoadError(name, error);
  }
}

export function loadVehicleState(caller: ToolCaller): Promise<VehicleState> {
  return step("status", async () => sanitizeVehicleStatus(await caller.callTool("get_vehicle_status", {})));
}

export function loadVehicleInfo(caller: ToolCaller): Promise<VehicleInfo> {
  return step("details", async () => sanitizeVehicleDetails(await caller.callTool("get_vehicle_details", {})));
}

export interface RoutesLoad {
  /** Every route found, oldest first. Short routes are still included here. */
  readonly routes: readonly Route[];
  /** Routes left out because they came without a usable start or km figure. */
  readonly skipped: number;
  /** `list_routes` requests made, including the ones repeated after a cut answer. */
  readonly requests: number;
}

export interface RoutesProgress {
  /** Routes loaded so far. */
  readonly loaded: number;
  /** Calendar year (UTC) of the semester being read. */
  readonly year: number;
}

/** Never look further back than this many calendar years. */
export const MAX_HISTORY_YEARS = 30;

/**
 * Reads the whole route history by natural semesters (UTC), from the current
 * one backwards, one request at a time. A semester the service cuts at its
 * limit is split in half and read again. Stops at the first whole past
 * calendar year without a single route; the current year does not count for
 * that, because it may simply not have a ride yet.
 */
export function loadAllRoutes(
  caller: ToolCaller,
  nowMs: number,
  onProgress?: (progress: RoutesProgress) => void,
): Promise<RoutesLoad> {
  return step("routes", async () => {
    // Without a usable clock there is no "current semester" to start from.
    if (Number.isNaN(new Date(nowMs).getTime())) throw new LoadError("routes", "unknown", "InvalidClock");
    const routes: Route[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let requests = 0;

    async function readPeriod(fromMs: number, toMs: number): Promise<number> {
      requests += 1;
      const page = sanitizeRouteList(
        await caller.callTool("list_routes", {
          from_time: new Date(fromMs).toISOString(),
          to_time: new Date(toMs).toISOString(),
        }),
      );
      if (page.truncated) {
        // Cut at the service's limit: the answer is dropped and the period
        // is read again in two halves.
        const middle = Math.floor((fromMs + toMs) / 2);
        if (middle <= fromMs) throw new LoadError("routes", "too_many_routes", null);
        return (await readPeriod(fromMs, middle)) + (await readPeriod(middle, toMs));
      }
      skipped += page.skipped;
      let added = 0;
      for (const route of page.routes) {
        // Guards against a route answered twice (for example on a shared
        // period boundary). The id never leaves this function.
        const id = serviceRouteId(route.ref);
        if (seen.has(id)) continue;
        seen.add(id);
        routes.push(route);
        added += 1;
      }
      return added + page.skipped;
    }

    const currentYear = new Date(nowMs).getUTCFullYear();
    for (let year = currentYear; year > currentYear - MAX_HISTORY_YEARS; year -= 1) {
      const july = Date.UTC(year, 6, 1);
      let found = 0;
      onProgress?.({ loaded: routes.length, year });
      if (july <= nowMs) found += await readPeriod(july, Date.UTC(year + 1, 0, 1));
      onProgress?.({ loaded: routes.length, year });
      found += await readPeriod(Date.UTC(year, 0, 1), july);
      if (found === 0 && year < currentYear) break;
    }
    routes.sort((a, b) => a.startMs - b.startMs);
    return { routes, skipped, requests };
  });
}

/**
 * Asks for one route's trace. The result is sealed: only the trim function
 * in `src/domain/trim.ts` can read its lines.
 */
export function loadRouteTrace(caller: ToolCaller, ref: RouteRef): Promise<UntrimmedTrace> {
  return step("detail", async () =>
    sanitizeRouteTrace(await caller.callTool("get_route_detail", { route_id: serviceRouteId(ref) })),
  );
}

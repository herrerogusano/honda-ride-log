/**
 * Loads a rider's data through a `ToolCaller`, without knowing whether the
 * demo service or the real `/mcp` client is behind it (docs/PLAN.md, "Carga
 * de datos"). One request at a time, never in parallel.
 *
 * Every answer goes through `src/domain/sanitize.ts` here, before anything
 * else can touch it. This is also the one place that opens a `RouteRef` to
 * ask for a route detail.
 */
import type { Route, RouteRef, UntrimmedTrace, VehicleInfo, VehicleOption, VehicleState } from "../domain/model";
import {
  needsRouteLookup,
  sanitizeRouteList,
  sanitizeRouteTrace,
  sanitizeVehicleDetails,
  sanitizeVehicleList,
  sanitizeVehicleStatus,
  serviceRouteId,
  ShapeError,
} from "../domain/sanitize";
import { AuthError, type AuthErrorKind } from "../auth/login";
import { ToolCallError, type ToolCaller } from "./contract";
import { ServiceError, UNKNOWN_TOOL_CODE, type ServiceErrorKind } from "./mcpClient";

/**
 * The step that failed. Each one has its own visible error code. `login` is
 * the way into the account: going to the login page or coming back from it.
 * `vehicles` is the list of the account's motorbikes (`list_vehicles`).
 */
export type LoadStep = "login" | "vehicles" | "status" | "details" | "routes" | "detail";

/**
 * What went wrong, in closed terms. The first five can happen with any
 * caller, the demo included; the sign-in kinds (`AuthErrorKind`) and the
 * transport kinds of the real `/mcp` client (`ServiceErrorKind`) keep their
 * own names (docs/PLAN.md, section 10, "Errores").
 */
export type FailureKind =
  | "tool_error"
  | "unexpected_shape"
  | "too_many_routes"
  | "cancelled"
  | "unknown"
  | AuthErrorKind
  | ServiceErrorKind;

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
/** An HTTP status or a JSON-RPC error code, as the `/mcp` client reports them. */
const SAFE_NUMBER = /^-?[0-9]{1,6}$/;

const safeDetail = (detail: string | null): string | null =>
  detail !== null && (SAFE_CODE.test(detail) || SAFE_NUMBER.test(detail)) ? detail : null;

function toLoadError(step: LoadStep, error: unknown): LoadError {
  if (error instanceof LoadError) return error;
  if (error instanceof ToolCallError) {
    // The code comes from the service: show it only if it looks like a code.
    return new LoadError(step, "tool_error", SAFE_CODE.test(error.code) ? error.code : null);
  }
  // Both carry a closed kind and a detail that is already a short code; the
  // detail is filtered again by its form, in case a later change slips a
  // value into it.
  if (error instanceof AuthError || error instanceof ServiceError) return new LoadError(step, error.kind, safeDetail(error.detail));
  if (error instanceof ShapeError) return new LoadError(step, "unexpected_shape", error.path);
  // Messages of unknown errors may quote data or addresses: keep the class name only.
  const name = error instanceof Error ? error.name : "";
  return new LoadError(step, "unknown", SAFE_NAME.test(name) ? name : null);
}

/** A failure on the way into the account (`startLogin`, `completeLogin`), as a visible error. */
export function signInError(error: unknown): LoadError {
  return toLoadError("login", error);
}

async function step<T>(name: LoadStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toLoadError(name, error);
  }
}

/**
 * Codes of a vehicle choice the service does not take: several vehicles and
 * no `vehicle_id`, or an id that is not one of the account's. The page
 * forgets the kept choice and reads the list again.
 */
export const VEHICLE_CHOICE_CODES: readonly string[] = ["vehicle_selection_required", "vehicle_not_found"];

/** Whether a failed load was about the vehicle choice (`VEHICLE_CHOICE_CODES`). */
export function isVehicleChoiceError(error: LoadError): boolean {
  return error.kind === "tool_error" && error.detail !== null && VEHICLE_CHOICE_CODES.includes(error.detail);
}

/**
 * `list_vehicles` is not there: an older deployment of the service, whose
 * MCP SDK answers exactly `Unknown tool: list_vehicles` (`unknown_tool`, see
 * src/service/mcpClient.ts). Only then does the page go on as before,
 * without a `vehicle_id`. Any other failure, an unreadable one included, is
 * a failure of the `vehicles` step with «Reintentar»: falling back on a
 * passing error would file new maintenance numbers under the plain key and
 * hide the ones already moved to the motorbike's key.
 */
function missingTool(error: unknown): boolean {
  return error instanceof ToolCallError && error.code === UNKNOWN_TOOL_CODE;
}

/**
 * The account's vehicles (`list_vehicles`), sanitized, in the service's
 * order; null when the service has no such tool (`missingTool`), so the page
 * works as it did before vehicle selection.
 */
export function loadVehicles(caller: ToolCaller): Promise<readonly VehicleOption[] | null> {
  return step("vehicles", async () => {
    let raw: unknown;
    try {
      raw = await caller.callTool("list_vehicles", {});
    } catch (error) {
      if (missingTool(error)) return null;
      throw error;
    }
    return sanitizeVehicleList(raw);
  });
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
 * Service codes after which the same period is asked once more: MAPIT did
 * not answer in time, or the service failed inside. Never the session, rate,
 * pause or availability codes, and never an error of this web.
 */
export const RETRY_CODES: readonly string[] = ["mapit_unavailable", "internal_error"];
/** Wait before asking the same period again. */
export const RETRY_DELAY_MS = 1_000;
/**
 * At most this many repeated requests in one load, whatever the number of
 * periods, so a bad day for MAPIT cannot eat the session's call budget.
 */
export const MAX_RETRIES_PER_LOAD = 2;

export interface RoutesLoadOptions {
  /** Only for tests: the wait before a repeated request. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the whole route history by natural semesters (UTC), from the current
 * one backwards, one request at a time. A semester the service cuts at its
 * limit is split in half and read again. Stops at the first whole past
 * calendar year without a single route; the current year does not count for
 * that, because it may simply not have a ride yet.
 *
 * `stillWanted` is asked before every request: when it answers false (the
 * user left, or another load replaced this one) nothing more is requested
 * and the load ends with a `cancelled` error.
 *
 * A period whose request fails with one of `RETRY_CODES` is asked once more
 * after `RETRY_DELAY_MS`, at most `MAX_RETRIES_PER_LOAD` times per load. If
 * that fails too, the load fails as before: no partial history is shown.
 */
export function loadAllRoutes(
  caller: ToolCaller,
  nowMs: number,
  onProgress?: (progress: RoutesProgress) => void,
  stillWanted: () => boolean = () => true,
  options: RoutesLoadOptions = {},
): Promise<RoutesLoad> {
  const sleep = options.sleep ?? wait;
  return step("routes", async () => {
    // Without a usable clock there is no "current semester" to start from.
    if (Number.isNaN(new Date(nowMs).getTime())) throw new LoadError("routes", "unknown", "InvalidClock");
    const routes: Route[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let requests = 0;
    let retries = 0;

    async function ask(fromMs: number, toMs: number): Promise<unknown> {
      const args = { from_time: new Date(fromMs).toISOString(), to_time: new Date(toMs).toISOString() };
      try {
        return await caller.callTool("list_routes", args);
      } catch (error) {
        const again = error instanceof ToolCallError && RETRY_CODES.includes(error.code) && retries < MAX_RETRIES_PER_LOAD;
        if (!again) throw error;
        retries += 1;
        await sleep(RETRY_DELAY_MS);
        if (!stillWanted()) throw new LoadError("routes", "cancelled", null);
        requests += 1;
        // Once: a second failure of the same period ends the load.
        return await caller.callTool("list_routes", args);
      }
    }

    async function readPeriod(fromMs: number, toMs: number): Promise<number> {
      if (!stillWanted()) throw new LoadError("routes", "cancelled", null);
      requests += 1;
      const page = sanitizeRouteList(await ask(fromMs, toMs));
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

/** What the loader needs of a route to ask for its trace. */
export type TracedRoute = Pick<Route, "ref" | "startMs" | "distanceKm">;

/**
 * Routes restored from the tab (`needsRouteLookup`) carry no service id: it
 * is never stored (docs/PLAN.md, section 10, «Los datos de la cuenta»). To
 * ask for one of their traces the loader reads the light list again, once
 * per period and per client, and takes the route that starts at the same
 * millisecond with the same km. The period is the route's natural UTC
 * semester, so an atlas of many routes costs one more read per semester,
 * not per route; a semester cut at the service's limit falls back to a
 * window of one millisecond around that start (`from_time` inclusive,
 * `to_time` exclusive). The routes found keep their own sealed refs; the
 * ids stay behind them in src/domain/sanitize.ts.
 */
type PeriodRefs = ReadonlyMap<string, RouteRef | null> | null;
/** One read of a period: on its way, or answered (`outcome`; null when the answer was cut). */
interface PeriodLookup {
  readonly asked: Promise<PeriodRefs>;
  outcome?: PeriodRefs;
}
const lookups = new WeakMap<ToolCaller, Map<string, PeriodLookup>>();

const lookupKey = (route: Pick<Route, "startMs" | "distanceKm">): string => `${route.startMs}|${route.distanceKm}`;

function semesterOf(startMs: number): readonly [number, number] {
  const date = new Date(startMs);
  const year = date.getUTCFullYear();
  return date.getUTCMonth() < 6 ? [Date.UTC(year, 0, 1), Date.UTC(year, 6, 1)] : [Date.UTC(year, 6, 1), Date.UTC(year + 1, 0, 1)];
}

/** The routes of one period by start and km (null for a key two routes share), or null if the answer was cut. */
function periodRefs(caller: ToolCaller, fromMs: number, toMs: number): Promise<PeriodRefs> {
  let byPeriod = lookups.get(caller);
  if (byPeriod === undefined) {
    byPeriod = new Map();
    lookups.set(caller, byPeriod);
  }
  const key = `${fromMs}-${toMs}`;
  const known = byPeriod.get(key);
  if (known !== undefined) return known.asked;
  const asked = (async () => {
    const page = sanitizeRouteList(
      await caller.callTool("list_routes", { from_time: new Date(fromMs).toISOString(), to_time: new Date(toMs).toISOString() }),
    );
    if (page.truncated) return null;
    const refs = new Map<string, RouteRef | null>();
    for (const route of page.routes) {
      const id = lookupKey(route);
      refs.set(id, refs.has(id) ? null : route.ref);
    }
    return refs;
  })();
  const lookup: PeriodLookup = { asked };
  byPeriod.set(key, lookup);
  asked.then(
    (outcome) => void (lookup.outcome = outcome),
    // A failed read is asked again next time.
    () => byPeriod.delete(key),
  );
  return asked;
}

/**
 * The most light reads finding these routes can add now (the atlas says
 * «hasta» what a build costs, so this never says fewer than are made). A
 * semester not read yet costs its read, and each of its routes may still
 * cost a read of one millisecond if that answer comes back cut; a semester
 * read in full costs nothing more; one known to be cut costs the narrow
 * reads not made yet. Exact once the semesters are known.
 */
export function routeLookupReads(caller: ToolCaller, routes: readonly TracedRoute[]): number {
  const byPeriod = lookups.get(caller);
  const reads = new Set<string>();
  for (const route of routes) {
    if (!needsRouteLookup(route.ref)) continue;
    const [fromMs, toMs] = semesterOf(route.startMs);
    const key = `${fromMs}-${toMs}`;
    const semester = byPeriod?.get(key);
    if (semester === undefined) reads.add(key);
    // Answered in full: the route is found there, or it is gone; nothing more is asked.
    if (semester?.outcome !== undefined && semester.outcome !== null) continue;
    const narrow = `${route.startMs}-${route.startMs + 1}`;
    if (byPeriod?.has(narrow) !== true) reads.add(narrow);
  }
  return reads.size;
}

async function serviceRef(caller: ToolCaller, route: TracedRoute): Promise<RouteRef> {
  const [fromMs, toMs] = semesterOf(route.startMs);
  const semester = await periodRefs(caller, fromMs, toMs);
  const found = semester !== null ? semester.get(lookupKey(route)) : (await periodRefs(caller, route.startMs, route.startMs + 1))?.get(lookupKey(route));
  // Gone from the service, changed, or two routes alike: nothing to ask for.
  if (found === undefined || found === null) throw new LoadError("detail", "unexpected_shape", "route_lookup");
  return found;
}

/**
 * Asks for one route's trace. The result is sealed: only the trim function
 * in `src/domain/trim.ts` can read its lines. A route restored from the tab
 * is first found again in the light list (`serviceRef`).
 */
export function loadRouteTrace(caller: ToolCaller, route: TracedRoute): Promise<UntrimmedTrace> {
  return step("detail", async () => {
    // A route loaded in this page is asked for at once, in the same turn.
    const ref = needsRouteLookup(route.ref) ? await serviceRef(caller, route) : route.ref;
    return sanitizeRouteTrace(await caller.callTool("get_route_detail", { route_id: serviceRouteId(ref) }));
  });
}

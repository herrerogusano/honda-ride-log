/**
 * The only module that reads raw service answers. It copies an allowlist of
 * fields into the app model and drops everything else on the spot: plate,
 * VIN, dealer, current position, the vehicle's current speed, route
 * odometers and time zones, raw payloads.
 *
 * Unknown extra fields are ignored (the service may grow); a missing or
 * mistyped field we depend on raises `ShapeError`, whose message names the
 * field path and the expected type but never includes a value.
 */
import type { AccountData, LatLng, Route, RouteListPage, RouteRef, TraceLine, UntrimmedTrace, VehicleInfo, VehicleState } from "./model";

export class ShapeError extends Error {
  readonly path: string;
  constructor(path: string, expected: string) {
    super(`unexpected shape at ${path}: expected ${expected}`);
    this.name = "ShapeError";
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function asObject(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ShapeError(path, "object");
  return value as Json;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(path, "array");
  return value;
}

function finiteOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ShapeError(path, "finite number or null");
  return value;
}

function stringOrNull(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ShapeError(path, "string or null");
  return value;
}

function boolOrNull(value: unknown, path: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new ShapeError(path, "boolean or null");
  return value;
}

/** Epoch milliseconds of an ISO 8601 instant with an explicit zone, else null. */
function instantOrNull(value: unknown, path: string): number | null {
  const text = stringOrNull(value, path);
  if (text === null) return null;
  // A zone is required: without it `Date.parse` would silently use local time.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map((part) => Number(part ?? 0));
  // `Date.parse` rolls impossible dates over (30 February becomes 2 March).
  const calendar = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  if (calendar.getUTCMonth() !== (month as number) - 1 || calendar.getUTCDate() !== day) return null;
  if ((hour as number) > 23 || (minute as number) > 59 || (second as number) > 59) return null;
  const ms = Date.parse(text);
  // The same range a kept copy must be in (`restoreAccount`): from 1970 on.
  return isInstantMs(ms) ? ms : null;
}

/** The largest instant a `Date` can hold (ECMAScript: 100 million days after 1970). */
const MAX_INSTANT_MS = 8.64e15;

/** Whole epoch milliseconds from 1970 to the last instant a `Date` holds: anything else is no date. */
function isInstantMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INSTANT_MS;
}

/**
 * An instant in epoch milliseconds; a number no date can hold (1e100, -1) is
 * treated as absent. The service sends this one as a float, so a fraction of
 * a millisecond is dropped (rounded down) rather than losing the date.
 */
function instantMsOrNull(value: unknown, path: string): number | null {
  const number = finiteOrNull(value, path);
  if (number === null) return null;
  const whole = Math.floor(number);
  return isInstantMs(whole) ? (whole === 0 ? 0 : whole) : null;
}

/** A finite number that is not negative; a negative one is treated as absent. */
function nonNegativeOrNull(value: unknown, path: string): number | null {
  const number = finiteOrNull(value, path);
  if (number === null || number < 0) return null;
  // JSON can carry -0, which passes `>= 0` and which Intl writes as "-0".
  return number === 0 ? 0 : number;
}

/**
 * A finite, non-negative number, or null for anything else (a string, NaN, a
 * negative). For display-only figures added later, such as the maximum speed:
 * a mistyped one must not cost the rider the whole route list.
 */
function nonNegativeOrAbsent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // JSON can carry -0, which passes `>= 0` and which Intl writes as "-0".
  return value === 0 ? 0 : value;
}

const MAX_LABEL_LENGTH = 60;

/** A short display label: control characters removed, length capped. */
function labelOrNull(value: unknown, path: string): string | null {
  const text = stringOrNull(value, path);
  if (text === null) return null;
  // Control and invisible formatting characters (bidi overrides, zero-width
  // marks, line separators) have no place in a label.
  const visible = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim();
  // Cut by code point so an emoji is never split in half.
  const clean = Array.from(visible).slice(0, MAX_LABEL_LENGTH).join("").trim();
  return clean === "" ? null : clean;
}

const routeIds = new WeakMap<RouteRef, string>();

function makeRouteRef(routeId: string): RouteRef {
  const ref = Object.freeze({}) as RouteRef;
  routeIds.set(ref, routeId);
  return ref;
}

/**
 * The service's route id behind a `RouteRef`. Call it only to build the
 * `get_route_detail` request. Never render, export, log or store the result.
 */
export function serviceRouteId(ref: RouteRef): string {
  const id = routeIds.get(ref);
  if (id === undefined) throw new ShapeError("routeRef", "a reference created by sanitizeRouteList");
  return id;
}

function sanitizeRoute(raw: unknown, path: string): Route | null {
  const item = asObject(raw, path);
  const routeId = item["route_id"];
  if (typeof routeId !== "string" || routeId.length === 0 || routeId.length > 256) {
    throw new ShapeError(`${path}.route_id`, "non-empty string");
  }
  const startMs = instantOrNull(item["started_at"], `${path}.started_at`);
  const distanceKm = finiteOrNull(item["distance_km"], `${path}.distance_km`);
  // Without a start or a km figure the route cannot be placed or counted.
  // The native `distance` is never converted here: its unit is unconfirmed.
  if (startMs === null || distanceKm === null || distanceKm < 0) return null;
  const rawEndMs = instantOrNull(item["ended_at"], `${path}.ended_at`);
  const endMs = rawEndMs !== null && rawEndMs >= startMs ? rawEndMs : null;
  return {
    ref: makeRouteRef(routeId),
    startMs,
    endMs,
    durationS: endMs === null ? null : (endMs - startMs) / 1000,
    distanceKm,
    averageSpeed: nonNegativeOrNull(item["average_speed"], `${path}.average_speed`),
    maxSpeed: nonNegativeOrAbsent(item["maximum_speed"]),
    hasInferredSegments: boolOrNull(item["has_inferred_segments"], `${path}.has_inferred_segments`),
  };
}

export function sanitizeRouteList(raw: unknown): RouteListPage {
  const list = asObject(raw, "list_routes");
  const rawRoutes = asArray(list["routes"], "list_routes.routes");
  const truncated = list["truncated"];
  if (typeof truncated !== "boolean") throw new ShapeError("list_routes.truncated", "boolean");
  const matched = list["matched_routes"];
  if (typeof matched !== "number" || !Number.isInteger(matched) || matched < rawRoutes.length) {
    throw new ShapeError("list_routes.matched_routes", "integer not below the number of routes");
  }
  const routes: Route[] = [];
  let skipped = 0;
  rawRoutes.forEach((rawRoute, index) => {
    const route = sanitizeRoute(rawRoute, `list_routes.routes[${index}]`);
    if (route === null) skipped += 1;
    else routes.push(route);
  });
  routes.sort((a, b) => a.startMs - b.startMs);
  // If the service matched more routes than it sent, the answer is cut even
  // when the flag says otherwise: the caller must split the period.
  return { routes, truncated: truncated || matched > rawRoutes.length, matched, skipped };
}

function percentOrNull(value: unknown, path: string): number | null {
  const number = finiteOrNull(value, path);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

export function sanitizeVehicleStatus(raw: unknown): VehicleState {
  const status = asObject(raw, "get_vehicle_status");
  // `position`, `speed`, `voltage` and `last_coordinate_update` are dropped here.
  return {
    status: labelOrNull(status["status"], "get_vehicle_status.status"),
    batteryPercent: percentOrNull(status["battery"], "get_vehicle_status.battery"),
    lastCommunicationMs: instantMsOrNull(status["last_communication"], "get_vehicle_status.last_communication"),
    odometer: nonNegativeOrNull(status["odometer"], "get_vehicle_status.odometer"),
  };
}

export function sanitizeVehicleDetails(raw: unknown): VehicleInfo {
  const details = asObject(raw, "get_vehicle_details");
  // `registration`, `vin`, `dealer`, `product`, `plan` and `branch` are dropped here.
  return {
    model: labelOrNull(details["model"], "get_vehicle_details.model"),
    mileage: nonNegativeOrNull(details["mileage"], "get_vehicle_details.mileage"),
  };
}

/**
 * Refs of routes restored from the tab (`restoreAccount`). There is no
 * service id behind them, here or anywhere: `serviceRouteId` refuses them.
 */
const restoredRefs = new WeakSet<RouteRef>();

/**
 * Whether this route came back from the tab and so has no service id yet:
 * the loader has to find it again with a light `list_routes` read before it
 * can ask for the trace. Says nothing about the id itself.
 */
export function needsRouteLookup(ref: RouteRef): boolean {
  return restoredRefs.has(ref);
}

/** Version of the value `accountSnapshot` makes; another one is discarded. */
const SNAPSHOT_VERSION = 1;
/** Far above any real history; a bigger list is not this web's. */
const MAX_SAVED_ROUTES = 100_000;

/**
 * The account data as a plain JSON value to keep in the tab (docs/PLAN.md,
 * section 10, «Los datos de la cuenta»). Each field is copied by name, so
 * nothing else can ride along: no `RouteRef` (and so no route id), no trace,
 * no start or end place, no email, no token. A route is
 * `[startMs, endMs, distanceKm, averageSpeed, maxSpeed, hasInferredSegments]`.
 */
export function accountSnapshot(data: AccountData): unknown {
  const { vehicle, info } = data;
  return {
    v: SNAPSHOT_VERSION,
    vehicle: [vehicle.status, vehicle.batteryPercent, vehicle.lastCommunicationMs, vehicle.odometer],
    info: info === null ? null : [info.model, info.mileage],
    skipped: data.skipped,
    routes: data.routes.map((route) => [route.startMs, route.endMs, route.distanceKm, route.averageSpeed, route.maxSpeed, route.hasInferredSegments]),
  };
}

function savedTuple(value: unknown, length: number, path: string): unknown[] {
  const tuple = asArray(value, path);
  if (tuple.length !== length) throw new ShapeError(path, `array of ${length}`);
  return tuple;
}

/** A kept instant or null; anything else means the copy is not one this page made. */
function savedInstantOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!isInstantMs(value)) throw new ShapeError(path, "instant or null");
  return value;
}

function savedRoute(raw: unknown, path: string): Route {
  const [start, end, km, average, max, inferred] = savedTuple(raw, 6, path);
  if (!isInstantMs(start)) throw new ShapeError(`${path}[0]`, "instant");
  // Not just finite: 1e100 is finite and no date (its day and time would read NaN).
  if (end !== null && (!isInstantMs(end) || end < start)) throw new ShapeError(`${path}[1]`, "instant not before the start or null");
  const endMs = end;
  const distanceKm = finiteOrNull(km, `${path}[2]`);
  if (distanceKm === null || distanceKm < 0) throw new ShapeError(`${path}[2]`, "non-negative number");
  const ref = Object.freeze({}) as RouteRef;
  restoredRefs.add(ref);
  return {
    ref,
    startMs: start,
    endMs,
    durationS: endMs === null ? null : (endMs - start) / 1000,
    distanceKm,
    averageSpeed: nonNegativeOrNull(average, `${path}[3]`),
    maxSpeed: nonNegativeOrNull(max, `${path}[4]`),
    hasInferredSegments: boolOrNull(inferred, `${path}[5]`),
  };
}

/**
 * The account data kept in the tab, checked again as untrusted input (the
 * tab's storage can be edited or damaged). Anything unexpected raises
 * `ShapeError` and the caller loads from the service as before. The routes
 * get new `RouteRef`s with no id behind them (`needsRouteLookup`).
 */
export function restoreAccount(raw: unknown): AccountData {
  const saved = asObject(raw, "saved");
  if (saved["v"] !== SNAPSHOT_VERSION) throw new ShapeError("saved.v", `${SNAPSHOT_VERSION}`);
  const [status, battery, lastCommunication, odometer] = savedTuple(saved["vehicle"], 4, "saved.vehicle");
  const vehicle: VehicleState = {
    status: labelOrNull(status, "saved.vehicle[0]"),
    batteryPercent: percentOrNull(battery, "saved.vehicle[1]"),
    lastCommunicationMs: savedInstantOrNull(lastCommunication, "saved.vehicle[2]"),
    odometer: nonNegativeOrNull(odometer, "saved.vehicle[3]"),
  };
  let info: VehicleInfo | null = null;
  if (saved["info"] !== null) {
    const [model, mileage] = savedTuple(saved["info"], 2, "saved.info");
    info = { model: labelOrNull(model, "saved.info[0]"), mileage: nonNegativeOrNull(mileage, "saved.info[1]") };
  }
  const skipped = saved["skipped"];
  if (typeof skipped !== "number" || !Number.isInteger(skipped) || skipped < 0) throw new ShapeError("saved.skipped", "non-negative integer");
  const rawRoutes = asArray(saved["routes"], "saved.routes");
  if (rawRoutes.length > MAX_SAVED_ROUTES) throw new ShapeError("saved.routes", `at most ${MAX_SAVED_ROUTES} routes`);
  const routes = rawRoutes.map((route, index) => savedRoute(route, `saved.routes[${index}]`));
  routes.sort((a, b) => a.startMs - b.startMs);
  return { vehicle, info, routes, skipped };
}

function sanitizePosition(raw: unknown, path: string): LatLng {
  const position = asArray(raw, path);
  const [longitude, latitude] = position;
  if (
    typeof longitude !== "number" || typeof latitude !== "number" ||
    !Number.isFinite(longitude) || !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 || Math.abs(longitude) > 180
  ) {
    throw new ShapeError(path, "[longitude, latitude, ...] within range");
  }
  return [latitude, longitude];
}

const traceLines = new WeakMap<UntrimmedTrace, readonly TraceLine[]>();
const tracePlaces = new WeakMap<UntrimmedTrace, readonly LatLng[]>();

/**
 * Lines of one route detail. The standalone start and end `Point` features
 * mark the exact places the trim exists to hide: they are never part of the
 * lines. They are kept, sealed, for one purpose only: so that the trim can
 * also hide whatever passes near them (see `sensitivePlaces`). A detail
 * without geometry yields no lines.
 */
export function sanitizeRouteTrace(raw: unknown): UntrimmedTrace {
  const detail = asObject(raw, "get_route_detail");
  const lines: TraceLine[] = [];
  const places: LatLng[] = [];
  const geojson = detail["geojson"];
  if (geojson !== null && geojson !== undefined) {
    const collection = asObject(geojson, "get_route_detail.geojson");
    const features = asArray(collection["features"], "get_route_detail.geojson.features");
    features.forEach((rawFeature, index) => {
      const path = `get_route_detail.geojson.features[${index}]`;
      const feature = asObject(rawFeature, path);
      // GeoJSON allows a feature without geometry: nothing to draw.
      if (feature["geometry"] === null || feature["geometry"] === undefined) return;
      const geometry = asObject(feature["geometry"], `${path}.geometry`);
      if (geometry["type"] === "Point") {
        // A malformed point is skipped, not fatal: the ends of the lines still
        // tell the trim what to hide.
        try {
          places.push(sanitizePosition(geometry["coordinates"], `${path}.geometry.coordinates`));
        } catch (error) {
          if (!(error instanceof ShapeError)) throw error;
        }
        return;
      }
      // Only LineString has been seen; any other geometry type is ignored
      // rather than guessed at.
      if (geometry["type"] !== "LineString") return;
      const coordinates = asArray(geometry["coordinates"], `${path}.geometry.coordinates`);
      const points = coordinates.map((position, i) => sanitizePosition(position, `${path}.geometry.coordinates[${i}]`));
      const properties = feature["properties"];
      const inferred =
        typeof properties === "object" && properties !== null
          ? (properties as Json)["inferred"]
          : undefined;
      // A missing or malformed flag means "unknown", never "not inferred".
      lines.push({ inferred: typeof inferred === "boolean" ? inferred : null, points });
    });
  }
  const trace = Object.freeze({}) as UntrimmedTrace;
  traceLines.set(trace, lines);
  tracePlaces.set(trace, places);
  return trace;
}

/**
 * The lines behind an `UntrimmedTrace`. Only src/domain/trim.ts may call it
 * (ESLint enforces the import); everything else gets its lines from there.
 */
export function untrimmedLines(trace: UntrimmedTrace): readonly TraceLine[] {
  const lines = traceLines.get(trace);
  if (lines === undefined) throw new ShapeError("untrimmedTrace", "a trace created by sanitizeRouteTrace");
  return lines;
}

/**
 * The exact start and end places the service marked in a route detail. They
 * exist to be hidden: only the trim function may call this (ESLint enforces
 * the import), and it uses them as centres of the areas it leaves undrawn.
 * Never draw, export, log or store them.
 */
export function sensitivePlaces(trace: UntrimmedTrace): readonly LatLng[] {
  const places = tracePlaces.get(trace);
  if (places === undefined) throw new ShapeError("untrimmedTrace", "a trace created by sanitizeRouteTrace");
  return places;
}

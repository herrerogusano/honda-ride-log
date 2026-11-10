/**
 * Synthetic rider data in the service's RAW shape (see
 * `src/service/contract.ts`). Used by the demo mode and by tests.
 *
 * Nothing here comes from a real account. Places are random walks around a
 * fixed made-up base point; ids, plate, VIN and dealer are obviously fake and
 * exist only so tests can prove the sanitizer drops them.
 *
 * The data deliberately contains the awkward cases seen in real answers:
 * routes of a few dozen metres, inferred segments, `timezone: null`, empty
 * months, and (profile `heavy`) more routes in one semester than
 * `list_routes` returns at once.
 */
import {
  CONVERSION_BASIS,
  NATIVE_UNIT,
  type RawGeoJson,
  type RawLineFeature,
  type RawPosition,
  type RawRouteDetail,
  type RawRouteSummary,
  type RawVehicleDetails,
  type RawVehicleStatus,
} from "../service/contract";
import { createRandom, hashSeed, type Random } from "./random";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The highest maximum speed a demo route reports, in km/h: about what a 125 cc tops out at. */
export const DEMO_TOP_SPEED = 115;

/**
 * Base point for every synthetic trace (latitude, longitude). An arbitrary
 * spot chosen for the demo; it has nothing to do with anyone's rides.
 */
export const DEMO_BASE: readonly [number, number] = [40.3456, -1.1065];

/** Marker inside every synthetic value that must never reach the screen. */
export const FORBIDDEN_MARK = "NO-MOSTRAR";

const WARNING_INFERRED =
  "At least one LineString is marked inferred; this does not establish real-street coverage or GPS accuracy.";
const WARNING_NOT_INFERRED = "No inspected LineString is marked inferred; this does not guarantee GPS accuracy.";

export type ProfileName = "commuter" | "heavy";

interface Profile {
  /** Days of history before `nowMs`. */
  readonly historyDays: number;
  /** How many whole months without a single route. */
  readonly emptyMonths: number;
  readonly planDay: (random: Random, weekday: number) => PlannedTrip[];
}

interface PlannedTrip {
  /** Start, hours after 00:00 UTC of the day. */
  readonly startHour: number;
  readonly distanceKm: number;
  readonly speedKmh: number;
}

const urban = (random: Random, startHour: number, distanceKm: number): PlannedTrip => ({
  startHour,
  distanceKm,
  speedKmh: random.between(22, 38),
});

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  /** Commutes on weekdays, an occasional long weekend ride. Under 500 routes per semester. */
  commuter: {
    historyDays: 880,
    emptyMonths: 3,
    planDay(random, weekday) {
      const trips: PlannedTrip[] = [];
      const workday = weekday >= 1 && weekday <= 5;
      if (workday) {
        if (random.chance(0.72)) {
          trips.push(urban(random, random.between(6, 8), random.between(7.6, 9.4)));
          trips.push(urban(random, random.between(16, 19), random.between(7.6, 9.8)));
        }
        if (random.chance(0.25)) trips.push(urban(random, random.between(10, 20.5), random.between(1, 4.5)));
      } else {
        if (random.chance(0.22)) {
          trips.push({
            startHour: random.between(7, 10),
            distanceKm: random.between(60, 230),
            speedKmh: random.between(55, 75),
          });
        }
        if (random.chance(0.35)) trips.push(urban(random, random.between(10, 19), random.between(5, 25)));
      }
      return trips;
    },
  },
  /** Many short trips six days a week: well over 500 routes per semester. */
  heavy: {
    historyDays: 400,
    emptyMonths: 1,
    planDay(random, weekday) {
      if (weekday === 0) return [];
      const count = random.int(3, 7);
      return Array.from({ length: count }, () => urban(random, random.between(9, 21), random.between(2, 9)));
    },
  },
};

export interface SyntheticRider {
  readonly status: RawVehicleStatus;
  readonly details: RawVehicleDetails;
  /** Every route, oldest first. */
  readonly routes: readonly RawRouteSummary[];
  /** Detail (with GeoJSON) of one route, or undefined for an unknown id. */
  detail(routeId: string): RawRouteDetail | undefined;
}

export interface GenerateOptions {
  readonly seed: number;
  /** "Now" of the synthetic world; history ends here. */
  readonly nowMs: number;
  readonly profile?: ProfileName;
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function demoRouteId(random: Random): string {
  let tail = "";
  for (let i = 0; i < 23; i += 1) tail += ID_ALPHABET[random.int(0, ID_ALPHABET.length - 1)];
  // Visibly synthetic: no real identifier contains this marker.
  return `rt-DEMO${tail}`;
}

function isoMillis(ms: number): string {
  return new Date(ms).toISOString();
}

function monthKey(ms: number): string {
  return isoMillis(ms).slice(0, 7);
}

function chooseEmptyMonths(random: Random, firstDayMs: number, nowMs: number, count: number): Set<string> {
  const months: string[] = [];
  for (let day = firstDayMs; day <= nowMs; day += DAY_MS) {
    const key = monthKey(day);
    if (months[months.length - 1] !== key) months.push(key);
  }
  // Keep the first two and the last two months busy so the history has a
  // clear beginning and "this month" always has something to show.
  const candidates = months.slice(2, -2);
  const chosen = new Set<string>();
  while (chosen.size < Math.min(count, candidates.length)) chosen.add(random.pick(candidates));
  return chosen;
}

function makeRoute(random: Random, startMs: number, trip: PlannedTrip): RawRouteSummary {
  const distance = Math.max(1, Math.round(trip.distanceKm * 1000));
  const durationS = Math.max(15, Math.round((distance / 1000 / trip.speedKmh) * 3600));
  const inferred = random.chance(0.25);
  const average = Math.max(1, Math.round(trip.speedKmh));
  return {
    route_id: demoRouteId(random),
    started_at: isoMillis(startMs),
    ended_at: isoMillis(startMs + durationS * 1000),
    distance,
    distance_km: distance / 1000,
    conversion_basis: CONVERSION_BASIS,
    has_inferred_segments: inferred,
    inference_quality_status: inferred ? "inferred_present" : "none_marked_inferred",
    inference_quality_source: "geojson_linestring_properties",
    inference_quality_warning: inferred ? WARNING_INFERRED : WARNING_NOT_INFERRED,
    average_speed: average,
    // Above the average and never past what a 125 cc reaches.
    maximum_speed: Math.min(average + random.int(15, 55), DEMO_TOP_SPEED),
    complete: false,
    timezone: random.chance(0.03) ? null : "Europe/Madrid",
    odometer_start: null,
    odometer_end: null,
  };
}

function generateRoutes(random: Random, profile: Profile, nowMs: number): RawRouteSummary[] {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const firstDay = today - profile.historyDays * DAY_MS;
  const emptyMonths = chooseEmptyMonths(random, firstDay, nowMs, profile.emptyMonths);
  const routes: RawRouteSummary[] = [];
  for (let day = firstDay; day <= today; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    const planned = profile.planDay(random, weekday).sort((a, b) => a.startHour - b.startHour);
    if (emptyMonths.has(monthKey(day))) continue;
    let freeFrom = day;
    for (const trip of planned) {
      const startMs = Math.max(Math.round(day + trip.startHour * HOUR_MS), freeFrom);
      const route = makeRoute(random, startMs, trip);
      let endMs = Date.parse(route.ended_at as string);
      if (endMs > nowMs) break;
      routes.push(route);
      // Now and then the bike is moved a few dozen metres right after a ride.
      if (random.chance(0.035)) {
        const shuffle = makeRoute(random, endMs + random.int(60, 600) * 1000, {
          startHour: 0,
          distanceKm: random.between(0.02, 0.28),
          speedKmh: random.between(4, 12),
        });
        const shuffleEnd = Date.parse(shuffle.ended_at as string);
        if (shuffleEnd <= nowMs) {
          routes.push(shuffle);
          endMs = shuffleEnd;
        }
      }
      freeFrom = endMs + 120_000;
    }
  }
  return routes;
}

function stepFrom(position: readonly [number, number], headingRad: number, metres: number): [number, number] {
  const [latitude, longitude] = position;
  const dLat = (metres * Math.cos(headingRad)) / 111_320;
  const dLon = (metres * Math.sin(headingRad)) / (111_320 * Math.cos((latitude * Math.PI) / 180));
  return [latitude + dLat, longitude + dLon];
}

function toRaw(position: readonly [number, number]): RawPosition {
  const round = (value: number): number => Math.round(value * 1e7) / 1e7;
  return [round(position[1]), round(position[0]), 0];
}

function buildGeoJson(route: RawRouteSummary, riderSeed: number): { geojson: RawGeoJson; trimmedEndM: number | null } {
  const random = createRandom(hashSeed(route.route_id) ^ riderSeed);
  const metres = route.distance ?? 0;
  // Real traces are sparse: 2 to 181 points, often hundreds of metres apart.
  const pointCount = Math.min(181, Math.max(2, Math.round(metres / 330)));
  // Most rides leave from one of three usual places near the base point.
  const usualPlaces = [0, 1, 2].map((i) => {
    const place = createRandom(riderSeed + i);
    return stepFrom(DEMO_BASE, place.between(0, 2 * Math.PI), place.between(200, 6000));
  });
  let position: [number, number] = random.chance(0.7)
    ? random.pick(usualPlaces)
    : stepFrom(DEMO_BASE, random.between(0, 2 * Math.PI), random.between(500, 15_000));
  let heading = random.between(0, 2 * Math.PI);
  const step = metres / (pointCount - 1);
  const path: [number, number][] = [position];
  for (let i = 1; i < pointCount; i += 1) {
    heading += random.between(-0.6, 0.6);
    position = stepFrom(position, heading, step);
    path.push(position);
  }

  const line = (points: [number, number][], inferred: boolean): RawLineFeature => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: points.map(toRaw) },
    properties: inferred
      ? { name: "inferred route", inferred: true }
      : { name: "detected route", inferred: false, maxSpeed: 0, avgSpeed: null, distance: null },
  });

  const lines: RawLineFeature[] = [];
  if (route.has_inferred_segments === true && pointCount >= 4) {
    const cut = random.int(1, Math.max(1, Math.floor(pointCount / 4)));
    lines.push(line(path.slice(0, cut + 1), true), line(path.slice(cut), false));
  } else {
    lines.push(line(path, route.has_inferred_segments === true));
  }

  const trimmedEndM = random.chance(0.35) ? random.int(50, 400) : null;
  const first = path[0] as [number, number];
  const last = path[path.length - 1] as [number, number];
  return {
    trimmedEndM,
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: toRaw(first) },
          properties: { name: "start", label: "S", inferred: route.has_inferred_segments === true },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: toRaw(last) },
          properties: trimmedEndM === null ? { name: "end", label: "E" } : { name: "end", label: "E", trimmed: true },
        },
        ...lines,
      ],
    },
  };
}

function hexLabel(random: Random): string {
  let label = "";
  for (let i = 0; i < 50; i += 1) label += "0123456789ABCDEF"[random.int(0, 15)];
  return label;
}

export function generateRider(options: GenerateOptions): SyntheticRider {
  const profile = PROFILES[options.profile ?? "commuter"];
  const random = createRandom(options.seed);
  const routes = generateRoutes(random, profile, options.nowMs);
  const byId = new Map(routes.map((route) => [route.route_id, route]));
  if (byId.size !== routes.length) throw new Error("synthetic route ids collided; change the seed");

  const riddenKm = routes.reduce((sum, route) => sum + (route.distance_km ?? 0), 0);
  const odometer = Math.round((random.int(1200, 9000) + riddenKm) * 1000) / 1000;
  const lastEnd = routes.length > 0 ? Date.parse(routes[routes.length - 1]?.ended_at ?? "") : options.nowMs;
  const parked = stepFrom(DEMO_BASE, random.between(0, 2 * Math.PI), random.between(200, 6000));

  const status: RawVehicleStatus = {
    status: "AT_REST",
    speed: 0,
    battery: random.int(30, 100),
    voltage: 0,
    last_communication: Math.min(options.nowMs, lastEnd + random.int(1, 6) * HOUR_MS),
    last_coordinate_update: lastEnd,
    position: {
      latitude: Math.round(parked[0] * 1e7) / 1e7,
      longitude: Math.round(parked[1] * 1e7) / 1e7,
      label: hexLabel(random),
      gps_accuracy: random.int(3, 12),
    },
    odometer,
    units_confirmed: false,
  };

  const details: RawVehicleDetails = {
    model: "Demo 125",
    registration: `0000 ${FORBIDDEN_MARK}`,
    vin: `VIN${FORBIDDEN_MARK}0000`,
    mileage: Math.round(odometer),
    product: `Producto ${FORBIDDEN_MARK}`,
    plan: `Plan ${FORBIDDEN_MARK}`,
    branch: `Sucursal ${FORBIDDEN_MARK}`,
    dealer: {
      name: `Concesionario ${FORBIDDEN_MARK}`,
      telephone: `000 ${FORBIDDEN_MARK}`,
      email: `${FORBIDDEN_MARK.toLowerCase()}@example.invalid`,
      address: `Calle ${FORBIDDEN_MARK} 1`,
      opening_hours: [`L-V 9-18 ${FORBIDDEN_MARK}`],
    },
    units_confirmed: false,
  };

  return {
    status,
    details,
    routes,
    detail(routeId) {
      const route = byId.get(routeId);
      if (route === undefined) return undefined;
      const { geojson, trimmedEndM } = buildGeoJson(route, options.seed);
      const detail: RawRouteDetail = {
        ...route,
        merged: false,
        starts_at_last_known: hashSeed(routeId) % 5 === 0,
        geojson,
        metric_unit: NATIVE_UNIT,
      };
      if (trimmedEndM !== null) detail.geometry_trimmed_end_m = trimmedEndM;
      return detail;
    },
  };
}

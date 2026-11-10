import type { Route } from "../src/domain/model";
import { sanitizeRouteList } from "../src/domain/sanitize";

export interface RideSpec {
  /** ISO 8601 instant with zone. Tests run in Los Angeles: say local time with `-08:00` or `-07:00`. */
  readonly start: string;
  readonly km: number;
  /** Minutes; null for a ride without a usable end. Defaults to 30. */
  readonly minutes?: number | null;
  readonly speed?: number | null;
  /** The raw `maximum_speed`; anything, so tests can send a broken one. Defaults to 60. */
  readonly maxSpeed?: unknown;
  /** The raw `has_inferred_segments`. Defaults to false. */
  readonly inferred?: boolean | null;
}

let counter = 0;

/** Sanitized routes built from the raw shape, the same way the web gets them. Oldest first. */
export function rides(specs: readonly RideSpec[]): Route[] {
  const raw = specs.map((spec) => {
    counter += 1;
    const startMs = Date.parse(spec.start);
    const minutes = spec.minutes === undefined ? 30 : spec.minutes;
    return {
      route_id: `rt-DEMO-test-${counter}`,
      started_at: new Date(startMs).toISOString(),
      ended_at: minutes === null ? null : new Date(startMs + minutes * 60_000).toISOString(),
      distance_km: spec.km,
      average_speed: spec.speed === undefined ? 30 : spec.speed,
      maximum_speed: spec.maxSpeed === undefined ? 60 : spec.maxSpeed,
      has_inferred_segments: spec.inferred === undefined ? false : spec.inferred,
    };
  });
  return [...sanitizeRouteList({ routes: raw, truncated: false, matched_routes: raw.length }).routes];
}

export function ride(spec: RideSpec): Route {
  return rides([spec])[0] as Route;
}

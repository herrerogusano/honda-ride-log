/**
 * What the rest of the web is allowed to hold. Everything here has already
 * passed `sanitize.ts`: no plate, VIN, dealer, position or raw payloads.
 */

declare const routeRefBrand: unique symbol;

/**
 * Opaque handle used to ask the service for one route's detail. It stands
 * for the service's route id, which must never be rendered, exported, logged
 * or stored. Only `serviceRouteId` in `sanitize.ts` can open it, and only the
 * code that calls `get_route_detail` should use that function.
 */
export type RouteRef = { readonly [routeRefBrand]: true };

export interface Route {
  readonly ref: RouteRef;
  /** Start instant, epoch milliseconds. Format it in the browser's zone only. */
  readonly startMs: number;
  /** End instant, or null when the service did not send a usable one. */
  readonly endMs: number | null;
  readonly durationS: number | null;
  /** The service's `distance_km` (conversion unconfirmed by the service). */
  readonly distanceKm: number;
  readonly averageSpeed: number | null;
  /** Descriptive flag from the service; not a GPS accuracy statement. */
  readonly hasInferredSegments: boolean | null;
}

export interface RouteListPage {
  readonly routes: readonly Route[];
  /** True when the service cut the answer at its limit: split the period. */
  readonly truncated: boolean;
  /** Routes the service matched in the period (may exceed `routes.length`). */
  readonly matched: number;
  /** Routes left out because they had no usable start or `distance_km`. */
  readonly skipped: number;
}

export interface VehicleState {
  readonly status: string | null;
  readonly batteryPercent: number | null;
  readonly lastCommunicationMs: number | null;
  readonly odometer: number | null;
}

export interface VehicleInfo {
  readonly model: string | null;
  readonly mileage: number | null;
}

/** `[latitude, longitude]`, the order Leaflet expects. */
export type LatLng = readonly [number, number];

export interface TraceLine {
  readonly inferred: boolean | null;
  readonly points: readonly LatLng[];
}

declare const untrimmedBrand: unique symbol;

/**
 * A route's lines exactly as the service sent them, start and end included.
 * It must NOT be drawn: phase 2 turns it into a drawable trace by cutting
 * `TRIM_METERS` from each end (see `privacy.ts`). The brand keeps map code
 * from accepting it by accident.
 */
export interface UntrimmedTrace {
  readonly [untrimmedBrand]: true;
  readonly lines: readonly TraceLine[];
}

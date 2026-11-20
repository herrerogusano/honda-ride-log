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
  /** The service's `average_speed`, shown as km/h (unit unconfirmed by the service). */
  readonly averageSpeed: number | null;
  /**
   * The service's `maximum_speed`, shown as km/h (unit unconfirmed by the
   * service). Shown since the owner's decision of 2026-11-10; never on the share card.
   */
  readonly maxSpeed: number | null;
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
  /**
   * The service says the vehicle is cancelled (`vehicle_cancelled`): its
   * state is the last one MAPIT stored, not a live one, so the page shows
   * «No disponible» instead. Left out (or false) for an active vehicle.
   */
  readonly cancelled?: boolean;
}

declare const vehicleRefBrand: unique symbol;

/**
 * Opaque handle for one of the account's vehicles. It stands for the
 * service's `vehicle_id`, which is never rendered, exported or sent to the
 * visit counters. Only `serviceVehicleId` in `sanitize.ts` opens it, and an
 * ESLint rule lets only src/service/ import that function.
 */
export type VehicleRef = { readonly [vehicleRefBrand]: true };

/** One vehicle of `list_vehicles`, sanitized: no registration, no position. */
export interface VehicleOption {
  readonly ref: VehicleRef;
  readonly model: string | null;
  readonly cancelled: boolean;
  /** Its state as `list_vehicles` gave it (the same fields as `get_vehicle_status`). */
  readonly state: VehicleState;
  /**
   * The last three characters of the registration, only when another
   * vehicle of the list has the same model (else null). For the selector's
   * label alone: never on the card, a download, the counters or storage.
   */
  readonly twinSuffix: string | null;
  /** Position in the service's answer (0 first). */
  readonly order: number;
}

export interface VehicleInfo {
  readonly model: string | null;
  readonly mileage: number | null;
}

/**
 * What a load of the account brings, kept in the tab so a reload paints it
 * at once (docs/PLAN.md, section 10, «Los datos de la cuenta»). Routes
 * restored from there carry a `RouteRef` with no service id behind it: the
 * loader finds the id again with a light `list_routes` read when a trace is
 * asked for.
 */
export interface AccountData {
  readonly vehicle: VehicleState;
  readonly info: VehicleInfo | null;
  /** Oldest first, short routes included. */
  readonly routes: readonly Route[];
  readonly skipped: number;
  /**
   * Which vehicle this data belongs to, as the hashed key of
   * src/service/vehicles.ts (`vehicleKey`, never the service's id); null or
   * left out when the page worked without vehicle selection. A kept copy is
   * painted only under the vehicle it was loaded for.
   */
  readonly vehicleKey?: string | null;
}

/** `[latitude, longitude]`, the order Leaflet expects. */
export type LatLng = readonly [number, number];

export interface TraceLine {
  readonly inferred: boolean | null;
  readonly points: readonly LatLng[];
}

declare const untrimmedBrand: unique symbol;

/**
 * Sealed handle to a route's lines exactly as the service sent them, start
 * and end included. It has no readable fields: the lines can only be taken
 * out with `untrimmedLines` in `sanitize.ts`, which is reserved (by an ESLint
 * rule) for src/domain/trim.ts. That module hands out the whole lines for the
 * screen (`screenTrace`, itself importable only by the trace store of the map
 * and the atlas) and the lines cut `TRIM_METERS` from each end for anything
 * else (`trimTrace`). Other code therefore cannot reach the lines by accident.
 */
export type UntrimmedTrace = { readonly [untrimmedBrand]: true };

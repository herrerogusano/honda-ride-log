/**
 * Contract of the four service tools the web uses, as read from the service
 * source (pydantic models with `extra="forbid"`) and checked against three
 * small real reads on 2026-11-09. See docs/PLAN.md, "Límites técnicos".
 *
 * These are the RAW shapes. They contain fields the web must never show
 * (registration, VIN, dealer, position, route ids): only
 * `src/domain/sanitize.ts` may read raw objects.
 */

/** A period (`to_time - from_time`) may not exceed this many days. */
export const MAX_PERIOD_DAYS = 366;
/** `list_routes` returns at most this many routes and then sets `truncated`. */
export const MAX_RETURNED_ROUTES = 500;

export const CONVERSION_BASIS = "ui_correlated_meter_interpretation_unconfirmed";
export const NATIVE_UNIT = "mapit_native_unconfirmed";

export type InferenceQualityStatus = "inferred_present" | "none_marked_inferred" | "partial_unknown" | "unknown";

export interface RawRouteSummary {
  route_id: string;
  /** ISO 8601 UTC with milliseconds, e.g. `2025-03-01T07:12:45.000Z`. */
  started_at: string | null;
  ended_at: string | null;
  /** Native unit, unconfirmed (observed: whole metres). Never label as km. */
  distance: number | null;
  /** Presentation companion; the only distance the web shows. */
  distance_km: number | null;
  conversion_basis: typeof CONVERSION_BASIS;
  has_inferred_segments: boolean | null;
  inference_quality_status: InferenceQualityStatus;
  inference_quality_source: string;
  inference_quality_warning: string;
  average_speed: number | null;
  maximum_speed: number | null;
  complete: boolean | null;
  timezone: string | null;
  odometer_start: number | null;
  odometer_end: number | null;
}

export interface RawRouteList {
  from_time: string;
  to_time: string;
  routes: RawRouteSummary[];
  matched_routes: number;
  returned_routes: number;
  truncated: boolean;
  completeness: "unverified";
  metric_unit: typeof NATIVE_UNIT;
  conversion_basis: typeof CONVERSION_BASIS;
}

/** GeoJSON position as observed: `[longitude, latitude, 0]`. */
export type RawPosition = [number, number, number];

export interface RawPointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: RawPosition };
  properties: { name: "start" | "end"; label: "S" | "E"; inferred?: boolean; trimmed?: boolean };
}

export interface RawLineFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: RawPosition[] };
  properties: {
    name: "detected route" | "inferred route";
    inferred: boolean;
    maxSpeed?: number;
    avgSpeed?: null;
    distance?: null;
  };
}

export interface RawGeoJson {
  type: "FeatureCollection";
  features: (RawPointFeature | RawLineFeature)[];
}

export interface RawRouteDetail extends RawRouteSummary {
  merged: boolean | null;
  starts_at_last_known: boolean | null;
  geojson: RawGeoJson | null;
  metric_unit: typeof NATIVE_UNIT;
  /** Seen in an older export (4 of 11 details), not in the current model. */
  geometry_trimmed_end_m?: number;
}

export interface RawVehicleStatus {
  status: string | null;
  speed: number | null;
  /** Observed as a whole percentage. */
  battery: number | null;
  voltage: number | null;
  /** Epoch milliseconds. */
  last_communication: number | null;
  last_coordinate_update: number | null;
  position: { latitude: number | null; longitude: number | null; label: string | null; gps_accuracy: number | null };
  odometer: number | null;
  units_confirmed: boolean;
}

export interface RawVehicleDetails {
  model: string | null;
  registration: string | null;
  vin: string | null;
  mileage: number | null;
  product: string | null;
  plan: string | null;
  branch: string | null;
  dealer: {
    name: string | null;
    telephone: string | null;
    email: string | null;
    address: string | null;
    opening_hours: string[];
  } | null;
  units_confirmed: boolean;
}

export interface ToolArguments {
  get_vehicle_status: Record<string, never>;
  get_vehicle_details: Record<string, never>;
  /** `from_time` inclusive, `to_time` exclusive; ISO date or datetime with timezone. */
  list_routes: { from_time: string; to_time: string };
  get_route_detail: { route_id: string };
}

export type ToolName = keyof ToolArguments;

/**
 * The one door to the service. Implemented by the demo service
 * (`src/demo/fakeService.ts`) and, in phase 3, by the real `/mcp` client.
 * Results are `unknown` on purpose: callers must sanitize them.
 */
export interface ToolCaller {
  callTool<N extends ToolName>(name: N, args: ToolArguments[N]): Promise<unknown>;
}

/**
 * A tool answered with an error. `code` is the code the service sent as
 * `code: message` (for example `period_too_large`), else `tool_error`.
 * The message must never contain tokens or user data.
 */
export class ToolCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ToolCallError";
    this.code = code;
  }
}

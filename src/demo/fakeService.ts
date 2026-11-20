/**
 * In-memory stand-in for the service, with the same five tools and the same
 * limits (period length, 500-route cap with `truncated`, `from` inclusive and
 * `to` exclusive) and the same vehicle selection (`list_vehicles`, an
 * optional `vehicle_id`, `vehicle_selection_required` with several vehicles
 * and none given, `vehicle_not_found`). It powers the demo mode and the
 * tests.
 *
 * It is a double: it reproduces the contract as read from the service code,
 * not the network, the login, CORS, timeouts or throttling.
 */
import {
  CONVERSION_BASIS,
  MAX_PERIOD_DAYS,
  MAX_RETURNED_ROUTES,
  NATIVE_UNIT,
  ToolCallError,
  type RawRouteList,
  type RawVehicleList,
  type ToolArguments,
  type ToolCaller,
  type ToolName,
} from "../service/contract";
import type { SyntheticRider } from "./generator";

const DAY_MS = 86_400_000;

function parseBoundary(value: unknown, field: string): number {
  const invalid = new ToolCallError("invalid_date_range", `${field} must be an ISO 8601 date or datetime`);
  if (typeof value !== "string" || value.trim() === "") throw invalid;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    // Reject impossible dates that `Date.parse` would roll over (30 February).
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) throw invalid;
    return ms;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?/.test(text)) throw invalid;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new ToolCallError("invalid_date_range", `${field} datetime must include a timezone`);
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw invalid;
  return ms;
}

export interface DemoService extends ToolCaller {
  /** Names of the tools called so far, in order (for tests and diagnostics). */
  readonly calls: readonly ToolName[];
  /** The `vehicle_id` each call carried (undefined: none), in the same order as `calls`. */
  readonly vehicleIds: readonly (string | undefined)[];
}

/** One synthetic motorbike of a demo account. Every value is invented. */
export interface DemoVehicle {
  readonly id: string;
  readonly model: string;
  readonly registration: string;
  readonly cancelled?: boolean;
  readonly rider: SyntheticRider;
}

/** The id of the one motorbike of a demo account made from a single rider. */
export const DEMO_VEHICLE_ID = "veh-DEMO-0001";

/** The service's fixed text for a cancelled vehicle's state (not read by the web). */
const STATE_WARNING = "Vehicle is cancelled: values are the last ones MAPIT stored, not live state.";

export function createDemoService(account: SyntheticRider | readonly DemoVehicle[]): DemoService {
  const calls: ToolName[] = [];
  const vehicleIds: (string | undefined)[] = [];
  const fleet: readonly DemoVehicle[] = Array.isArray(account)
    ? (account as readonly DemoVehicle[])
    : [
        {
          id: DEMO_VEHICLE_ID,
          model: (account as SyntheticRider).details.model ?? "Demo 125",
          registration: (account as SyntheticRider).details.registration ?? "",
          rider: account as SyntheticRider,
        },
      ];
  if (fleet.length === 0) throw new RangeError("a demo account needs a vehicle");

  function statusOf(vehicle: DemoVehicle): unknown {
    const status = vehicle.rider.status;
    return vehicle.cancelled === true ? { ...status, vehicle_cancelled: true, state_warning: STATE_WARNING } : status;
  }

  function listVehicles(): RawVehicleList {
    return {
      vehicles: fleet.map((vehicle) => ({
        vehicle_id: vehicle.id,
        model: vehicle.model,
        registration: vehicle.registration,
        cancelled: vehicle.cancelled === true,
        status: statusOf(vehicle) as RawVehicleList["vehicles"][number]["status"],
      })),
      vehicle_count: fleet.length,
      selection_required: fleet.length > 1,
      selection_basis: "mapit_dashboard_filter",
      selection_hint: "When more than one vehicle is listed, pass vehicle_id to every vehicle-scoped tool.",
    };
  }

  /** The vehicle a call works on, as the service picks it. */
  function vehicleFor(args: unknown): DemoVehicle {
    const given = (args as { vehicle_id?: unknown } | null)?.vehicle_id;
    if (given === undefined || given === null) {
      if (fleet.length === 1) return fleet[0] as DemoVehicle;
      throw new ToolCallError("vehicle_selection_required", `this account has ${fleet.length} vehicles; call list_vehicles and pass vehicle_id`);
    }
    const found = typeof given === "string" ? fleet.find((vehicle) => vehicle.id === given) : undefined;
    if (found === undefined) throw new ToolCallError("vehicle_not_found", "vehicle not found");
    return found;
  }

  function listRoutes(rider: SyntheticRider, args: ToolArguments["list_routes"]): RawRouteList {
    const from = parseBoundary(args.from_time, "from_time");
    const to = parseBoundary(args.to_time, "to_time");
    if (from >= to) throw new ToolCallError("invalid_date_range", "from_time must be earlier than to_time");
    if (to - from > MAX_PERIOD_DAYS * DAY_MS) {
      throw new ToolCallError("period_too_large", `a period may not exceed ${MAX_PERIOD_DAYS} days`);
    }
    const matched = rider.routes.filter((route) => {
      const start = Date.parse(route.started_at ?? "");
      return start >= from && start < to;
    });
    const returned = matched.slice(0, MAX_RETURNED_ROUTES);
    return {
      from_time: new Date(from).toISOString(),
      to_time: new Date(to).toISOString(),
      routes: returned,
      matched_routes: matched.length,
      returned_routes: returned.length,
      truncated: returned.length < matched.length,
      completeness: "unverified",
      metric_unit: NATIVE_UNIT,
      conversion_basis: CONVERSION_BASIS,
    };
  }

  function run(name: ToolName, args: ToolArguments[ToolName]): unknown {
    if (name === "list_vehicles") return listVehicles();
    const vehicle = vehicleFor(args);
    const rider = vehicle.rider;
    switch (name) {
      case "get_vehicle_status":
        return statusOf(vehicle);
      case "get_vehicle_details":
        return { ...rider.details, model: vehicle.model, registration: vehicle.registration };
      case "list_routes":
        return listRoutes(rider, args as ToolArguments["list_routes"]);
      case "get_route_detail": {
        const routeId = (args as ToolArguments["get_route_detail"]).route_id;
        if (typeof routeId !== "string" || routeId.trim() === "" || routeId.length > 256) {
          throw new ToolCallError("invalid_route_id", "route_id must be a non-empty string of at most 256 characters");
        }
        const detail = rider.detail(routeId);
        // The real code for an unknown id has not been observed; this one is a placeholder.
        if (detail === undefined) throw new ToolCallError("tool_error", "route not available");
        return detail;
      }
      default:
        throw new ToolCallError("tool_error", "unknown tool");
    }
  }

  return {
    calls,
    vehicleIds,
    async callTool(name, args) {
      calls.push(name);
      const id = (args as { vehicle_id?: unknown } | null)?.vehicle_id;
      vehicleIds.push(typeof id === "string" ? id : undefined);
      // A JSON round trip, like the network: callers cannot share or mutate our objects.
      return JSON.parse(JSON.stringify(run(name, args))) as unknown;
    },
  };
}

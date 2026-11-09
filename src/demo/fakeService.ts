/**
 * In-memory stand-in for the service, with the same four tools and the same
 * limits (period length, 500-route cap with `truncated`, `from` inclusive and
 * `to` exclusive). It powers the demo mode and the tests.
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
    if (Number.isNaN(ms)) throw invalid;
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
}

export function createDemoService(rider: SyntheticRider): DemoService {
  const calls: ToolName[] = [];

  function listRoutes(args: ToolArguments["list_routes"]): RawRouteList {
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
    switch (name) {
      case "get_vehicle_status":
        return rider.status;
      case "get_vehicle_details":
        return rider.details;
      case "list_routes":
        return listRoutes(args as ToolArguments["list_routes"]);
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
    }
  }

  return {
    calls,
    async callTool(name, args) {
      calls.push(name);
      // A JSON round trip, like the network: callers cannot share or mutate our objects.
      return JSON.parse(JSON.stringify(run(name, args))) as unknown;
    },
  };
}

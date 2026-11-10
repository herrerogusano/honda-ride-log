/** What the three tabs work with once the load has finished. */
import { SHORT_ROUTES_COUNT_IN_FIGURES } from "../config";
import type { Route, VehicleInfo, VehicleState } from "../domain/model";
import { hideShortRoutes } from "../domain/privacy";
import type { RoutesLoad } from "../service/loader";

export interface RiderData {
  readonly vehicle: VehicleState;
  /** Null when the vehicle details could not be read; the web works without them. */
  readonly info: VehicleInfo | null;
  /** Routes that may be listed and drawn: those of 300 m or more. Oldest first. */
  readonly routes: readonly Route[];
  /** Routes the figures are computed from (see `src/config.ts`). */
  readonly figures: readonly Route[];
  /** Routes under 300 m, never listed nor drawn. */
  readonly hiddenShort: number;
  /** Whether the hidden short routes are part of `figures`. */
  readonly shortCounted: boolean;
  /** Routes the service sent without a usable date or km figure. */
  readonly skipped: number;
  /** True for synthetic data. */
  readonly demo: boolean;
  readonly nowMs: number;
}

export function buildRiderData(
  vehicle: VehicleState,
  info: VehicleInfo | null,
  load: RoutesLoad,
  demo: boolean,
  nowMs: number,
  countShort: boolean = SHORT_ROUTES_COUNT_IN_FIGURES,
): RiderData {
  const split = hideShortRoutes(load.routes);
  return {
    vehicle,
    info,
    routes: split.visible,
    figures: countShort ? load.routes : split.visible,
    hiddenShort: split.hiddenCount,
    shortCounted: countShort,
    skipped: load.skipped,
    demo,
    nowMs,
  };
}

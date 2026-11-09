import type { Route } from "./model";

/** Metres removed from the start and from the end of every drawn trace. */
export const TRIM_METERS = 400;

/** Routes shorter than this are left out of the list, the map and the figures. */
export const MIN_ROUTE_KM = 0.3;

export interface ShortRouteSplit {
  readonly visible: readonly Route[];
  /** How many routes were left out; shown as a footnote, never listed. */
  readonly hiddenCount: number;
}

export function hideShortRoutes(routes: readonly Route[]): ShortRouteSplit {
  const visible = routes.filter((route) => route.distanceKm >= MIN_ROUTE_KM);
  return { visible, hiddenCount: routes.length - visible.length };
}

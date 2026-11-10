/** Service interval arithmetic. The two numbers are typed by the user. */

export interface MaintenancePlan {
  /** Kilometres between two services. */
  readonly intervalKm: number;
  /** Odometer reading at the last service. */
  readonly lastServiceKm: number;
}

export const MAX_INTERVAL_KM = 100_000;
export const MAX_ODOMETER_KM = 10_000_000;

/** A plan with sane numbers, or null. Used for what the user types and for what was stored. */
export function validPlan(intervalKm: unknown, lastServiceKm: unknown): MaintenancePlan | null {
  if (typeof intervalKm !== "number" || typeof lastServiceKm !== "number") return null;
  if (!Number.isFinite(intervalKm) || !Number.isFinite(lastServiceKm)) return null;
  if (intervalKm <= 0 || intervalKm > MAX_INTERVAL_KM) return null;
  if (lastServiceKm < 0 || lastServiceKm > MAX_ODOMETER_KM) return null;
  return { intervalKm, lastServiceKm };
}

export interface MaintenanceStatus {
  /** Odometer reading at which the next service is due. */
  readonly dueAtKm: number;
  /** Kilometres left; negative when the service is overdue. */
  readonly remainingKm: number;
}

export function maintenanceStatus(plan: MaintenancePlan, odometerKm: number): MaintenanceStatus {
  const dueAtKm = plan.lastServiceKm + plan.intervalKm;
  return { dueAtKm, remainingKm: dueAtKm - odometerKm };
}

/**
 * How much of the interval has been ridden since the last service, 0 to 1,
 * for the bar under the figure: full when the service is due or overdue,
 * empty if the odometer reads less than at the last service.
 */
export function maintenanceProgress(plan: MaintenancePlan, odometerKm: number): number {
  const share = (odometerKm - plan.lastServiceKm) / plan.intervalKm;
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
}

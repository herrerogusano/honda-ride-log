/**
 * THE ONLY FILE THAT MAY USE BROWSER STORAGE (docs/PLAN.md, "Privacidad";
 * ESLint lifts the `localStorage` ban for this file alone).
 *
 * It keeps the two numbers the user types for the service interval, and
 * nothing else: never a token, a route, a figure from the service or an
 * identifier. The demo keeps its own copy so that playing with it does not
 * overwrite the real numbers.
 */
import { validPlan, type MaintenancePlan } from "../domain/maintenance";

export type StorageScope = "account" | "demo";

const KEYS: Readonly<Record<StorageScope, string>> = {
  account: "ride-log.maintenance.v1",
  demo: "ride-log.demo.maintenance.v1",
};

/** The stored plan, or null if there is none, it is damaged or storage is unavailable. */
export function readMaintenance(scope: StorageScope): MaintenancePlan | null {
  try {
    const text = localStorage.getItem(KEYS[scope]);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return validPlan(record["intervalKm"], record["lastServiceKm"]);
  } catch {
    return null;
  }
}

/** Stores the plan. False when the browser refuses (private mode, storage full or disabled). */
export function writeMaintenance(scope: StorageScope, plan: MaintenancePlan): boolean {
  const clean = validPlan(plan.intervalKm, plan.lastServiceKm);
  if (clean === null) return false;
  try {
    // Only the two validated numbers are written, whatever else the object carries.
    localStorage.setItem(KEYS[scope], JSON.stringify({ intervalKm: clean.intervalKm, lastServiceKm: clean.lastServiceKm }));
    return true;
  } catch {
    return false;
  }
}

export function clearMaintenance(scope: StorageScope): void {
  try {
    localStorage.removeItem(KEYS[scope]);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * THE ONLY FILE THAT MAY USE BROWSER STORAGE (docs/PLAN.md, "Privacidad";
 * ESLint lifts the `localStorage` ban for this file alone).
 *
 * It keeps the two numbers the user types for the service interval, and
 * nothing else: never a token, a route, a figure from the service or an
 * identifier. The demo keeps its own copy so that playing with it does not
 * overwrite the real numbers.
 *
 * Since vehicle selection (docs/PLAN.md, section 19) each motorbike has its
 * own pair, filed under its hashed key (`keyOfVehicleId` in
 * src/service/vehicles.ts: 16 hex digits of SHA-256, never the service's
 * `vehicle_id`). The pair kept before that, under the plain key, belongs to
 * the first motorbike the service lists (with one motorbike, to that one):
 * `adoptLegacyMaintenance` moves it there once. A page that works without
 * vehicle selection (an older service) keeps using the plain key.
 */
import { validPlan, type MaintenancePlan } from "../domain/maintenance";

export type StorageScope = "account" | "demo";

const KEYS: Readonly<Record<StorageScope, string>> = {
  account: "ride-log.maintenance.v1",
  demo: "ride-log.demo.maintenance.v1",
};

const VEHICLE_KEY = /^[0-9a-f]{16}$/;

/** Where one motorbike's pair lives: its scope, and its hashed key (null: the plain key of a page without selection). */
export interface MaintenanceSlot {
  readonly scope: StorageScope;
  readonly vehicleKey: string | null;
}

function storageKey(slot: MaintenanceSlot | StorageScope): string {
  const { scope, vehicleKey } = typeof slot === "string" ? { scope: slot, vehicleKey: null } : slot;
  if (vehicleKey === null) return KEYS[scope];
  // Only a key `keyOfVehicleId` made: never a raw id or anything else.
  if (!VEHICLE_KEY.test(vehicleKey)) throw new TypeError("vehicle key");
  return `${KEYS[scope]}.${vehicleKey}`;
}

function readKey(key: string): MaintenancePlan | null {
  const text = localStorage.getItem(key);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return validPlan(record["intervalKm"], record["lastServiceKm"]);
}

/** The stored plan, or null if there is none, it is damaged or storage is unavailable. */
export function readMaintenance(slot: MaintenanceSlot | StorageScope): MaintenancePlan | null {
  try {
    return readKey(storageKey(slot));
  } catch {
    return null;
  }
}

/** Stores the plan. False when the browser refuses (private mode, storage full or disabled). */
export function writeMaintenance(slot: MaintenanceSlot | StorageScope, plan: MaintenancePlan): boolean {
  const clean = validPlan(plan.intervalKm, plan.lastServiceKm);
  if (clean === null) return false;
  try {
    // Only the two validated numbers are written, whatever else the object carries.
    localStorage.setItem(storageKey(slot), JSON.stringify({ intervalKm: clean.intervalKm, lastServiceKm: clean.lastServiceKm }));
    return true;
  } catch {
    return false;
  }
}

export function clearMaintenance(slot: MaintenanceSlot | StorageScope): void {
  try {
    localStorage.removeItem(storageKey(slot));
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Moves the pair kept under the plain key (before vehicle selection) to the
 * motorbike with this hashed key: the first one the service lists. Only when
 * that motorbike has no pair of its own; the plain key is removed once the
 * copy is written, so the pair can never be adopted by a second motorbike.
 * A damaged plain entry is left alone.
 */
export function adoptLegacyMaintenance(scope: StorageScope, vehicleKey: string): void {
  try {
    const target = storageKey({ scope, vehicleKey });
    if (localStorage.getItem(target) !== null) return;
    const legacy = readKey(KEYS[scope]);
    if (legacy === null) return;
    localStorage.setItem(target, JSON.stringify({ intervalKm: legacy.intervalKm, lastServiceKm: legacy.lastServiceKm }));
    localStorage.removeItem(KEYS[scope]);
  } catch {
    // Storage unavailable: the pair stays where it is.
  }
}

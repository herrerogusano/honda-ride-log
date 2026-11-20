/**
 * Vehicle selection (docs/PLAN.md, section 19): an account may have several
 * motorbikes and the page shows one at a time. This module is the one place
 * that opens a `VehicleRef` (an ESLint rule keeps `serviceVehicleId` inside
 * src/service/): to send `vehicle_id` with every vehicle tool, to keep the
 * choice in the tab and to make the hashed key that names a vehicle in
 * browser storage.
 */
import type { VehicleOption, VehicleRef } from "../domain/model";
import { serviceVehicleId, VEHICLE_KEY_PATTERN } from "../domain/sanitize";
import type { ToolArguments, ToolCaller, ToolName } from "./contract";

/**
 * The order of the selector: active vehicles first, cancelled ones last,
 * each group in the order the service listed them.
 */
export function selectorOrder(list: readonly VehicleOption[]): readonly VehicleOption[] {
  return [...list.filter((one) => !one.cancelled), ...list.filter((one) => one.cancelled)];
}

/**
 * The vehicle shown when nothing was chosen in this tab: the one with the
 * most recent `last_communication` in `list_vehicles`. That is the device's
 * last report to MAPIT, which follows the last ride closely but is not
 * strictly it (a parked bike still reports now and then). A tie, or no time
 * at all, goes to the first in the service's order. Cancelled vehicles are
 * chosen only when every vehicle is cancelled.
 */
export function defaultVehicle(list: readonly VehicleOption[]): VehicleOption {
  const active = list.filter((one) => !one.cancelled);
  const pool = active.length > 0 ? active : list;
  let best: VehicleOption | undefined;
  for (const one of pool) {
    if (best === undefined) {
      best = one;
      continue;
    }
    const time = one.state.lastCommunicationMs;
    const bestTime = best.state.lastCommunicationMs;
    // Strictly newer only: on a tie the earlier one in the list stays.
    if (time !== null && (bestTime === null || time > bestTime)) best = one;
  }
  if (best === undefined) throw new RangeError("no vehicles");
  return best;
}

const callers = new WeakMap<ToolCaller, WeakMap<VehicleRef, ToolCaller>>();

/**
 * A caller that adds this vehicle's `vehicle_id` to every vehicle tool
 * (with a single vehicle too: the service allows it and answers the same).
 * The same caller comes back for the same ref, so what the loader keeps per
 * caller (the light lists of `loadRouteTrace`) stays per vehicle.
 */
export function vehicleCaller(base: ToolCaller, ref: VehicleRef): ToolCaller {
  let byRef = callers.get(base);
  if (byRef === undefined) {
    byRef = new WeakMap();
    callers.set(base, byRef);
  }
  const known = byRef.get(ref);
  if (known !== undefined) return known;
  const caller: ToolCaller = {
    callTool<N extends ToolName>(name: N, args: ToolArguments[N]): Promise<unknown> {
      if (name === "list_vehicles") return base.callTool(name, args);
      return base.callTool(name, { ...args, vehicle_id: serviceVehicleId(ref) } as ToolArguments[N]);
    },
  };
  byRef.set(ref, caller);
  return caller;
}

/** Separates these hashes from any other use of SHA-256 on the same id. */
const KEY_CONTEXT = "ride-log.vehicle:";

/**
 * The name of a vehicle in browser storage: the first 64 bits of
 * SHA-256(`ride-log.vehicle:` + vehicle_id), as 16 hex digits. The
 * maintenance numbers (`localStorage`, kept across sessions) and the copy of
 * the account in the tab are filed under it, so the service's raw id is
 * never written to `localStorage`. It is not a secret: whoever knows an id
 * can compute its key. 64 bits keep a handful of vehicles in one browser
 * apart with room to spare.
 */
export async function keyOfVehicleId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY_CONTEXT + id));
  const key = Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!VEHICLE_KEY_PATTERN.test(key)) throw new RangeError("vehicle key");
  return key;
}

export function vehicleKey(ref: VehicleRef): Promise<string> {
  return keyOfVehicleId(serviceVehicleId(ref));
}

/**
 * Where the chosen `vehicle_id` lives between reloads: the tab's
 * `sessionStorage` next to the session for a real account (src/auth/login.ts,
 * removed with it), a variable in the demo.
 */
export interface ChoiceStore {
  read(): string | null;
  write(id: string | null): void;
}

/** The vehicle chosen in this tab, kept through a `ChoiceStore`. */
export interface VehicleMemory {
  /** The kept vehicle if it is still in `list`, else null. */
  recall(list: readonly VehicleOption[]): VehicleOption | null;
  remember(vehicle: VehicleOption): void;
  /** The kept choice is wrong (the service no longer knows it): drop it. */
  forget(): void;
  /** The storage key of the kept vehicle (`keyOfVehicleId`), or null when none is kept. */
  storedKey(): Promise<string | null>;
}

export function vehicleMemory(store: ChoiceStore): VehicleMemory {
  const read = (): string | null => {
    try {
      return store.read();
    } catch {
      return null;
    }
  };
  const write = (id: string | null): void => {
    try {
      store.write(id);
    } catch {
      // A tab that refuses to keep it: the next reload shows the default vehicle.
    }
  };
  return {
    recall(list) {
      const id = read();
      return id === null ? null : (list.find((one) => serviceVehicleId(one.ref) === id) ?? null);
    },
    remember(vehicle) {
      write(serviceVehicleId(vehicle.ref));
    },
    forget() {
      write(null);
    },
    async storedKey() {
      const id = read();
      return id === null ? null : keyOfVehicleId(id);
    },
  };
}

/** A store in a variable, for the demo and for a page without one. */
export function memoryChoiceStore(): ChoiceStore {
  let kept: string | null = null;
  return {
    read: () => kept,
    write: (id) => {
      kept = id;
    },
  };
}

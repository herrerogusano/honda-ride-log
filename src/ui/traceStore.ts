/**
 * The trimmed traces of the view on screen, shared by the map of «Rutas»
 * and the atlas (docs/PLAN.md, sections 6, 13 and 15). Each route detail
 * costs one read of the service: a route is asked at most once, whoever
 * asks first, and a request already on its way is shared. Only the lines
 * that went through `trimTrace` are kept; the untrimmed trace is dropped as
 * soon as it is trimmed.
 */
import type { Route, RouteRef } from "../domain/model";
import { trimTrace, type TrimmedTrace } from "../domain/trim";
import type { ToolCaller } from "../service/contract";
import { loadRouteTrace } from "../service/loader";

export interface TraceStore {
  /** The trimmed trace of a route already read, without asking anything. */
  known(ref: RouteRef): TrimmedTrace | undefined;
  /** Whether asking for this route would cost nothing new: it is known or already on its way. */
  has(ref: RouteRef): boolean;
  /** The trimmed trace: from memory, from a request on its way, or from one new request. */
  get(route: Route): Promise<TrimmedTrace>;
  /** Calls `listener` each time a new trace is kept (the atlas updates what a build would cost). */
  onChange(listener: () => void): void;
  /** Forgets every trace; answers still on their way are not kept. The store must not be used afterwards. */
  dispose(): void;
}

export function createTraceStore(caller: ToolCaller): TraceStore {
  const traces = new Map<RouteRef, TrimmedTrace>();
  const pending = new Map<RouteRef, Promise<TrimmedTrace>>();
  let disposed = false;
  const listeners: (() => void)[] = [];
  return {
    known: (ref) => traces.get(ref),
    has: (ref) => traces.has(ref) || pending.has(ref),
    get(route) {
      const known = traces.get(route.ref);
      if (known !== undefined) return Promise.resolve(known);
      let request = pending.get(route.ref);
      if (request === undefined) {
        request = loadRouteTrace(caller, route.ref)
          .then((untrimmed) => {
            // Only the trimmed lines are kept; the untrimmed trace is dropped here.
            const trimmed = trimTrace(untrimmed);
            // An answer that arrives after the view is gone is not kept.
            if (!disposed) {
              traces.set(route.ref, trimmed);
              for (const listener of listeners) listener();
            }
            return trimmed;
          })
          .finally(() => pending.delete(route.ref));
        pending.set(route.ref, request);
      }
      return request;
    },
    onChange: (listener) => void listeners.push(listener),
    dispose() {
      disposed = true;
      listeners.length = 0;
      traces.clear();
      pending.clear();
    },
  };
}

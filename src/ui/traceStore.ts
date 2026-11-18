/**
 * The traces of the view on screen, shared by the map of «Rutas» and the
 * atlas (docs/PLAN.md, sections 4, 6, 13 and 15). Each route detail costs
 * one read of the service: a route is asked at most once, whoever asks
 * first, and a request already on its way is shared. Only the lines that
 * `screenTrace` hands out are kept (the whole trace, for this screen only;
 * the start and end places the service marks apart are not); the sealed
 * detail is dropped as soon as they are taken out. This is the only module
 * allowed to import `screenTrace` (ESLint guards it).
 */
import type { Route, RouteRef } from "../domain/model";
import { screenTrace, type ScreenTrace } from "../domain/trim";
import type { ToolCaller } from "../service/contract";
import { LoadError, loadRouteTrace } from "../service/loader";

export interface TraceStore {
  /** The trace of a route already read, without asking anything. */
  known(ref: RouteRef): ScreenTrace | undefined;
  /** Whether asking for this route would cost nothing new: it is known or already on its way. */
  has(ref: RouteRef): boolean;
  /** The trace: from memory, from a request on its way, or from one new request. */
  get(route: Route): Promise<ScreenTrace>;
  /** Calls `listener` each time a new trace is kept (the atlas updates what a build would cost). */
  onChange(listener: () => void): void;
  /**
   * Forgets every trace and every request on its way (their answers are not
   * kept, and their callers get a `reauth_required` error instead of the
   * lines), and tells the listeners. The store can still be asked; the
   * page calls it when the session ends.
   */
  forget(): void;
  /** Forgets every trace; answers still on their way are not kept. The store must not be used afterwards. */
  dispose(): void;
}

export function createTraceStore(caller: ToolCaller): TraceStore {
  const traces = new Map<RouteRef, ScreenTrace>();
  const pending = new Map<RouteRef, Promise<ScreenTrace>>();
  let disposed = false;
  /** Each forget starts a new round; an answer from an earlier round is not kept. */
  let round = 0;
  const listeners: (() => void)[] = [];
  return {
    known: (ref) => traces.get(ref),
    has: (ref) => traces.has(ref) || pending.has(ref),
    get(route) {
      const known = traces.get(route.ref);
      if (known !== undefined) return Promise.resolve(known);
      let request = pending.get(route.ref);
      if (request === undefined) {
        const mine = round;
        request = loadRouteTrace(caller, route.ref)
          .then((detail) => {
            // Only the lines for the screen are kept; the sealed detail is dropped here.
            const lines = screenTrace(detail);
            // An answer that arrives after the view is gone, or after the
            // session ended, is neither kept nor handed out to be drawn.
            if (disposed) throw new LoadError("detail", "cancelled", null);
            if (mine !== round) throw new LoadError("detail", "reauth_required", null);
            traces.set(route.ref, lines);
            for (const listener of listeners) listener();
            return lines;
          })
          .finally(() => {
            if (pending.get(route.ref) === request) pending.delete(route.ref);
          });
        pending.set(route.ref, request);
      }
      return request;
    },
    onChange: (listener) => void listeners.push(listener),
    forget() {
      round += 1;
      traces.clear();
      pending.clear();
      for (const listener of [...listeners]) listener();
    },
    dispose() {
      disposed = true;
      listeners.length = 0;
      traces.clear();
      pending.clear();
    },
  };
}

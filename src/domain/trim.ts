/**
 * Privacy trim: keeps the places where a ride begins and ends off the map.
 *
 * Nothing is drawn within `HIDE_RADIUS_METERS` in a straight line of the
 * start or the end of a ride, however the ride got there. That removes the
 * first and the last `TRIM_METERS` of travelled distance (a point that
 * close along the road is at least that close in a straight line) and also
 * what a cut by distance alone would leave on the map: a round trip coming
 * back to where it started, or a ride that passes its own start again.
 *
 * Points of a trace are far apart (often more than the trim itself), so the
 * cut is made inside a segment, with a new interpolated point. Dropping the
 * first and last N points would be wrong.
 *
 * The rule does not depend on the order in which the service sends the
 * lines: its centres are the first and last point of the lines and the start
 * and end places the service marks apart.
 *
 * This is the only module allowed to open an `UntrimmedTrace` (ESLint
 * guards the imports). The radius is not a parameter on purpose: no caller
 * can ask for a shorter cut.
 */
import type { LatLng, TraceLine, UntrimmedTrace } from "./model";
import { TRIM_METERS } from "./privacy";
import { sensitivePlaces, untrimmedLines } from "./sanitize";

const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_M) / 180;
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Radius of the area left undrawn around the start and the end. One metre
 * more than the trim, to absorb the error of measuring on a flat map.
 */
export const HIDE_RADIUS_METERS = TRIM_METERS + 1;

/** Great-circle distance in metres between two `[latitude, longitude]` points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point at `fraction` (0 to 1) of the way from `a` to `b`, linear in latitude and longitude. */
function between(a: LatLng, b: LatLng, fraction: number): LatLng {
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
}

export interface TrimmedTrace {
  /** Lines that may be drawn. Empty when nothing is left. */
  readonly lines: readonly TraceLine[];
  /**
   * Why there is nothing to draw: the service sent no line at all
   * (`no_geometry`) or the whole trace fell inside the trim (`hidden`).
   * Null when there are lines.
   */
  readonly empty: "no_geometry" | "hidden" | null;
}

/**
 * The part of the segment from `a` to `b` (as fractions 0 to 1) that lies
 * inside the circle around `centre`, or null. `a` and `b` must differ. Measured on a flat map centred
 * on `centre`, which is accurate where it matters: near the centre.
 */
function insideCircle(a: LatLng, b: LatLng, centre: LatLng): [number, number] | null {
  const scale = Math.cos(toRad(centre[0])) * METERS_PER_DEGREE;
  const ax = (a[1] - centre[1]) * scale;
  const ay = (a[0] - centre[0]) * METERS_PER_DEGREE;
  const dx = (b[1] - a[1]) * scale;
  const dy = (b[0] - a[0]) * METERS_PER_DEGREE;
  const squared = dx * dx + dy * dy;
  const reach = ax * ax + ay * ay - HIDE_RADIUS_METERS ** 2;
  const half = ax * dx + ay * dy;
  const discriminant = half * half - squared * reach;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const from = Math.max(0, (-half - root) / squared);
  const to = Math.min(1, (-half + root) / squared);
  return from <= to ? [from, to] : null;
}

/** The lines without whatever lies within the hidden radius of any centre. */
function hideAround(lines: readonly TraceLine[], centres: readonly LatLng[]): TraceLine[] {
  const result: TraceLine[] = [];
  for (const line of lines) {
    let piece: LatLng[] = [];
    const close = (): void => {
      if (piece.length >= 2) result.push({ inferred: line.inferred, points: piece });
      piece = [];
    };
    for (let index = 1; index < line.points.length; index += 1) {
      const a = line.points[index - 1] as LatLng;
      const b = line.points[index] as LatLng;
      // A repeated point adds nothing to draw.
      if (a[0] === b[0] && a[1] === b[1]) continue;
      // Visible stretches of this segment: start with all of it and take
      // away what each circle covers.
      let visible: [number, number][] = [[0, 1]];
      for (const centre of centres) {
        const hidden = insideCircle(a, b, centre);
        if (hidden === null) continue;
        visible = visible.flatMap(([from, to]): [number, number][] => [
          [from, Math.min(to, hidden[0])],
          [Math.max(from, hidden[1]), to],
        ]);
        visible = visible.filter(([from, to]) => from < to);
      }
      let reached = 0;
      for (const [from, to] of visible) {
        // A stretch that does not continue the previous one starts a new line.
        if (from > reached || piece.length === 0) {
          close();
          piece.push(from === 0 ? a : between(a, b, from));
        }
        piece.push(to === 1 ? b : between(a, b, to));
        reached = to;
      }
      // The segment ends hidden: what comes next is another line, even if it
      // starts exactly on the edge of the hidden area.
      if (reached < 1) close();
    }
    close();
  }
  return result;
}

/**
 * The lines of a route that may be drawn: everything except what lies near
 * its start or its end. A trace of `2 * TRIM_METERS` or less always leaves
 * nothing, because each of its points is that close to one of the two.
 */
export function trimTrace(trace: UntrimmedTrace): TrimmedTrace {
  const all = untrimmedLines(trace);
  const source = all.filter((line) => line.points.length >= 2);
  if (source.length === 0) return { lines: [], empty: "no_geometry" };

  const points = all.flatMap((line) => line.points);
  const centres = [points[0] as LatLng, points[points.length - 1] as LatLng, ...sensitivePlaces(trace)];
  const lines = hideAround(source, centres);
  return lines.length > 0 ? { lines, empty: null } : { lines: [], empty: "hidden" };
}

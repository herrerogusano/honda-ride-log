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
 * cut is made inside a segment, with a new point. Dropping the first and
 * last N points would be wrong.
 *
 * The geometry is done on the map projection (Web Mercator), because that
 * is where the map joins two points with a straight line: what is measured
 * here is the line that will be drawn, also for a segment of many
 * kilometres.
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
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
const toDeg = (radians: number): number => (radians * 180) / Math.PI;
/** The projection has no poles: latitudes are held inside this, as map libraries do. */
const MAX_LATITUDE = 85.0511;
/** Width of the whole world on the projection. */
const WORLD = 2 * Math.PI * EARTH_RADIUS_M;

/**
 * Radius of the area left undrawn around the start and the end. One metre
 * more than the trim, to absorb the small error of measuring on the map
 * projection with the scale of the centre.
 */
export const HIDE_RADIUS_METERS = TRIM_METERS + 1;

/** Great-circle distance in metres between two `[latitude, longitude]` points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A point on the map projection: metres at the equator, stretched by 1 / cos(latitude) elsewhere. */
type Projected = readonly [x: number, y: number];

function project(point: LatLng): Projected {
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point[0]));
  return [EARTH_RADIUS_M * toRad(point[1]), EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + toRad(latitude) / 2))];
}

function unproject(point: Projected): LatLng {
  return [toDeg(2 * Math.atan(Math.exp(point[1] / EARTH_RADIUS_M)) - Math.PI / 2), toDeg(point[0] / EARTH_RADIUS_M)];
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

/** A place to hide: where it is on the projection and how big the hidden radius is there. */
interface Hidden {
  readonly at: Projected;
  readonly radius: number;
}

function hiddenAround(place: LatLng): Hidden {
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, place[0]));
  // On the projection, a metre at this latitude measures 1 / cos(latitude).
  return { at: project(place), radius: HIDE_RADIUS_METERS / Math.cos(toRad(latitude)) };
}

/**
 * The part of the straight segment from `a` to `b` (as fractions 0 to 1)
 * that lies inside a circle, or null. `a` and `b` must differ.
 */
function insideCircle(a: Projected, b: Projected, centreX: number, centreY: number, radius: number): [number, number] | null {
  const ax = a[0] - centreX;
  const ay = a[1] - centreY;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const squared = dx * dx + dy * dy;
  const half = ax * dx + ay * dy;
  const discriminant = half * half - squared * (ax * ax + ay * ay - radius * radius);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const from = Math.max(0, (-half - root) / squared);
  const to = Math.min(1, (-half + root) / squared);
  return from <= to ? [from, to] : null;
}

/** The lines without whatever lies within the hidden radius of any of the places. */
function hideAround(lines: readonly TraceLine[], places: readonly Hidden[]): TraceLine[] {
  const result: TraceLine[] = [];
  for (const line of lines) {
    let piece: LatLng[] = [];
    const close = (): void => {
      if (piece.length >= 2) result.push({ inferred: line.inferred, points: piece });
      piece = [];
    };
    for (let index = 1; index < line.points.length; index += 1) {
      const start = line.points[index - 1] as LatLng;
      const end = line.points[index] as LatLng;
      // A repeated point adds nothing to draw.
      if (start[0] === end[0] && start[1] === end[1]) continue;
      const a = project(start);
      const b = project(end);
      const at = (fraction: number): LatLng => unproject([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]);
      // Visible stretches of this segment: start with all of it and take
      // away what each circle covers.
      let visible: [number, number][] = [[0, 1]];
      for (const place of places) {
        // The world repeats sideways on the map: a place near its edge is
        // also hidden from a segment drawn on the other side of that edge.
        for (const turn of [-WORLD, 0, WORLD]) {
          const hidden = insideCircle(a, b, place.at[0] + turn, place.at[1], place.radius);
          if (hidden === null) continue;
          visible = visible.flatMap(([from, to]): [number, number][] => [
            [from, Math.min(to, hidden[0])],
            [Math.max(from, hidden[1]), to],
          ]);
          visible = visible.filter(([from, to]) => from < to);
        }
      }
      let reached = 0;
      for (const [from, to] of visible) {
        // A stretch that does not continue the previous one starts a new line.
        if (from > reached || piece.length === 0) {
          close();
          piece.push(from === 0 ? start : at(from));
        }
        piece.push(to === 1 ? end : at(to));
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
 * its start or its end. With the start and end places the service marks, a
 * trace of `2 * TRIM_METERS` or less always leaves nothing, because each of
 * its points is that close to one of the two.
 */
export function trimTrace(trace: UntrimmedTrace): TrimmedTrace {
  const all = untrimmedLines(trace).filter((line) => line.points.length >= 1);
  const source = all.filter((line) => line.points.length >= 2);
  if (source.length === 0) return { lines: [], empty: "no_geometry" };

  const marked = sensitivePlaces(trace);
  const ends = all.flatMap((line) => [line.points[0] as LatLng, line.points[line.points.length - 1] as LatLng]);
  // The start and the end are the two places the service marks and the two
  // ends of the lines taken together. Without the marks, which line comes
  // first cannot be trusted either: then the ends of every line are hidden,
  // at the price of a gap wherever two lines meet.
  const centres = marked.length > 0 ? [ends[0] as LatLng, ends[ends.length - 1] as LatLng, ...marked] : ends;
  const lines = hideAround(source, centres.map(hiddenAround));
  return lines.length > 0 ? { lines, empty: null } : { lines: [], empty: "hidden" };
}

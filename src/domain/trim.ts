/**
 * Privacy trim: removes `TRIM_METERS` of travelled distance from the start
 * and from the end of a route's trace, so the places where a ride begins and
 * ends are never drawn.
 *
 * Points of a trace are far apart (often more than the trim itself), so the
 * cut is made by distance inside a segment, with a new interpolated point.
 * Dropping the first and last N points would be wrong.
 *
 * This is the only module allowed to open an `UntrimmedTrace` (ESLint
 * guards the `untrimmedLines` import). The trim length is not a parameter
 * on purpose: no caller can ask for a shorter cut.
 */
import type { LatLng, TraceLine, UntrimmedTrace } from "./model";
import { TRIM_METERS } from "./privacy";
import { untrimmedLines } from "./sanitize";

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two `[latitude, longitude]` points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point at `fraction` (0 to 1) of the way from `a` to `b`. Segments are short, so linear is enough. */
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
 * Cuts `TRIM_METERS` from the start of the first line and from the end of
 * the last one, measured along the lines taken together. Gaps between two
 * lines are not travelled trace and do not count as distance. A trace of
 * `2 * TRIM_METERS` or less leaves nothing.
 */
export function trimTrace(trace: UntrimmedTrace): TrimmedTrace {
  const source = untrimmedLines(trace).filter((line) => line.points.length >= 2);
  if (source.length === 0) return { lines: [], empty: "no_geometry" };

  const lengths = source.map((line) =>
    line.points.slice(1).map((point, index) => distanceMeters(line.points[index] as LatLng, point)),
  );
  let total = 0;
  for (const segments of lengths) for (const length of segments) total += length;
  if (!(total > 2 * TRIM_METERS)) return { lines: [], empty: "hidden" };

  const keepFrom = TRIM_METERS;
  const keepTo = total - TRIM_METERS;
  const lines: TraceLine[] = [];
  let offset = 0;
  source.forEach((line, lineIndex) => {
    const kept: LatLng[] = [];
    (lengths[lineIndex] as number[]).forEach((length, index) => {
      const segmentStart = offset;
      const segmentEnd = offset + length;
      offset = segmentEnd;
      if (length === 0) return;
      const from = Math.max(segmentStart, keepFrom);
      const to = Math.min(segmentEnd, keepTo);
      if (!(from < to)) return;
      const a = line.points[index] as LatLng;
      const b = line.points[index + 1] as LatLng;
      if (kept.length === 0) kept.push(from === segmentStart ? a : between(a, b, (from - segmentStart) / length));
      kept.push(to === segmentEnd ? b : between(a, b, (to - segmentStart) / length));
    });
    if (kept.length >= 2) lines.push({ inferred: line.inferred, points: kept });
  });
  return lines.length > 0 ? { lines, empty: null } : { lines: [], empty: "hidden" };
}

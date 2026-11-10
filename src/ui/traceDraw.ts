/**
 * The trace drawing itself (docs/PLAN.md, section 13): a route's trimmed
 * lines grow from their first point to their last, at a pace proportional
 * to length, with a bright head leading the stroke.
 *
 * Privacy: this module only ever sees lines that already went through
 * `trimTrace` (src/domain/trim.ts). Every point it hands out is a vertex of
 * those lines or lies on one of their segments, interpolated on the map's
 * own projection (Web Mercator), where the map draws a segment as a
 * straight line. So a partial drawing is always a piece of the final one,
 * and the head never leaves it.
 */
import type { LatLng, TraceLine } from "../domain/model";

const EARTH_RADIUS_M = 6_378_137;
const MAX_LATITUDE = 85.051_128_779_806_59;
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
const toDeg = (radians: number): number => (radians * 180) / Math.PI;

type Projected = readonly [number, number];

function project(point: LatLng): Projected {
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, point[0]));
  return [EARTH_RADIUS_M * toRad(point[1]), EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + toRad(latitude) / 2))];
}

function unproject(point: Projected): LatLng {
  return [toDeg(2 * Math.atan(Math.exp(point[1] / EARTH_RADIUS_M)) - Math.PI / 2), toDeg(point[0] / EARTH_RADIUS_M)];
}

/** The lines and, for each, the distance on the projection from its first point to each of its points. */
export interface TracePlan {
  readonly lines: readonly TraceLine[];
  readonly reach: readonly (readonly number[])[];
  /** Total length on the projection, in projected metres. */
  readonly total: number;
}

export function planTrace(lines: readonly TraceLine[]): TracePlan {
  let total = 0;
  const reach = lines.map((line) => {
    const projected = line.points.map(project);
    let along = 0;
    return projected.map((point, index) => {
      const before = projected[index - 1];
      if (before !== undefined) along += Math.hypot(point[0] - before[0], point[1] - before[1]);
      return along;
    });
  });
  for (const one of reach) total += one[one.length - 1] ?? 0;
  return { lines, reach, total };
}

export interface PartialTrace {
  /** What is drawn so far: whole lines, then the line being drawn up to the head. */
  readonly lines: readonly TraceLine[];
  /** Where the stroke is now; null once the drawing is complete. */
  readonly head: LatLng | null;
}

/**
 * The drawing at `fraction` (0 to 1) of the plan's length. At 1 it is the
 * plan's own lines, the same objects, and no head.
 */
export function partialTrace(plan: TracePlan, fraction: number): PartialTrace {
  if (fraction >= 1 || plan.total === 0) return { lines: plan.lines, head: null };
  let left = Math.max(0, fraction) * plan.total;
  const drawn: TraceLine[] = [];
  for (const [index, line] of plan.lines.entries()) {
    const reach = plan.reach[index] as readonly number[];
    const length = reach[reach.length - 1] ?? 0;
    if (length <= left) {
      drawn.push(line);
      left -= length;
      continue;
    }
    // This line is being drawn: its points up to the head, then the head on its segment.
    let next = 1;
    while ((reach[next] as number) <= left) next += 1;
    const from = line.points[next - 1] as LatLng;
    const to = line.points[next] as LatLng;
    const span = (reach[next] as number) - (reach[next - 1] as number);
    const t = span > 0 ? (left - (reach[next - 1] as number)) / span : 0;
    const a = project(from);
    const b = project(to);
    const head = t <= 0 ? from : unproject([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    const points = line.points.slice(0, next);
    if (t > 0) points.push(head);
    drawn.push({ inferred: line.inferred, points });
    return { lines: drawn, head };
  }
  return { lines: plan.lines, head: null };
}

/** How long the drawing lasts: 1.5 to 2 times `--dur-hero`, longer for longer traces (30 km and over: 2). */
export function drawDuration(plan: TracePlan, heroMs: number): number {
  return heroMs * (1.5 + 0.5 * Math.min(1, plan.total / 30_000));
}

/** Symmetric ease-in-out, gentler than `--ease-in-out` so the head never races through the middle. */
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

export interface DrawOptions {
  readonly durationMs: number;
  /** Called on every frame with the drawing so far, and once at the end with the complete lines. */
  readonly paint: (partial: PartialTrace) => void;
  /** Called once, after the complete lines were painted (also when finished early). */
  readonly done?: () => void;
}

export interface Drawing {
  /** Stops at once and paints the complete lines. */
  finish(): void;
  /** Stops at once and paints nothing more. */
  cancel(): void;
}

/** Grows the plan's lines with animation frames. The first frame paints nothing yet: an empty start. */
export function drawTrace(plan: TracePlan, options: DrawOptions): Drawing {
  let frame = 0;
  let over = false;
  let began: number | null = null;

  function stop(): void {
    over = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  }

  function finish(): void {
    if (over) return;
    stop();
    options.paint({ lines: plan.lines, head: null });
    options.done?.();
  }

  const step = (now: number): void => {
    frame = 0;
    began ??= now;
    const t = options.durationMs > 0 ? (now - began) / options.durationMs : 1;
    if (t >= 1) {
      finish();
      return;
    }
    options.paint(partialTrace(plan, easeInOut(Math.max(0, t))));
    frame = requestAnimationFrame(step);
  };
  options.paint({ lines: [], head: null });
  frame = requestAnimationFrame(step);
  return { finish, cancel: stop };
}

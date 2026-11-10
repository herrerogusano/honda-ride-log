/**
 * The atlas's own math (docs/PLAN.md, section 15): no WebGL, no library.
 *
 * - The plane: trimmed lat/lon become kilometres on a local plane
 *   (equirectangular around the centre of the set), then plate units, the
 *   plate being the square from -1 to 1 on both axes. x grows to the east,
 *   y to the north.
 * - The camera: a yaw about the vertical axis, a tilt (0 = looking straight
 *   from the side, 90° = straight down) and a perspective division, all by
 *   hand. A straight segment in space projects to a straight segment on
 *   screen, so a point on a projected trimmed segment is on the trace.
 *
 * Privacy: the plane only ever receives `TrimmedTrace` lines. Every point it
 * produces is the affine image of a trimmed vertex.
 */
import type { LatLng, TraceLine } from "../../domain/model";

const KM_PER_DEGREE_LAT = 110.574;
const KM_PER_DEGREE_LON_AT_EQUATOR = 111.32;
const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Room left between the farthest trace and the edge of the plate. */
export const PLATE_MARGIN = 1.08;
/** Steps the ground grid may use, in km. */
export const GRID_STEPS_KM: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 500];
/** Grid cells across the plate the step aims for. */
const GOOD_CELLS = 8;

export type PlanePoint = readonly [number, number];

export interface PlaneLine {
  readonly inferred: boolean | null;
  readonly points: readonly PlanePoint[];
}

export interface Plane {
  /** Centre of the set, in degrees. */
  readonly center: LatLng;
  /** Kilometres from the centre of the plate to its edge. */
  readonly halfKm: number;
  /** Kilometres per degree of longitude and of latitude at the centre. */
  readonly kmPerDegree: readonly [number, number];
}

/** The plane that fits every line of every trace, centred on their bounding box. */
export function fitPlane(traces: readonly (readonly TraceLine[])[]): Plane {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const lines of traces) {
    for (const line of lines) {
      for (const [lat, lon] of line.points) {
        south = Math.min(south, lat);
        north = Math.max(north, lat);
        west = Math.min(west, lon);
        east = Math.max(east, lon);
      }
    }
  }
  if (!Number.isFinite(south)) return { center: [0, 0], halfKm: 1, kmPerDegree: [KM_PER_DEGREE_LON_AT_EQUATOR, KM_PER_DEGREE_LAT] };
  const center: LatLng = [(south + north) / 2, (west + east) / 2];
  const kmPerDegree = [KM_PER_DEGREE_LON_AT_EQUATOR * Math.cos(toRad(center[0])), KM_PER_DEGREE_LAT] as const;
  const width = (east - west) * kmPerDegree[0];
  const height = (north - south) * kmPerDegree[1];
  // A set of one tiny trace still gets a plate of at least a kilometre each side.
  const halfKm = Math.max(0.5, (Math.max(width, height) / 2) * PLATE_MARGIN);
  return { center, halfKm, kmPerDegree };
}

/** One trimmed point on the plate. */
export function toPlane(plane: Plane, point: LatLng): PlanePoint {
  return [
    ((point[1] - plane.center[1]) * plane.kmPerDegree[0]) / plane.halfKm,
    ((point[0] - plane.center[0]) * plane.kmPerDegree[1]) / plane.halfKm,
  ];
}

export function linesToPlane(plane: Plane, lines: readonly TraceLine[]): PlaneLine[] {
  return lines.map((line) => ({ inferred: line.inferred, points: line.points.map((point) => toPlane(plane, point)) }));
}

/** The grid step in km: the smallest of 1, 2, 5, 10, 20… that leaves at most ten cells across the plate. */
export function gridStepKm(halfKm: number): number {
  // The step whose cell count across the plate is closest to eight (6 to 10 whenever the ladder allows).
  let best = GRID_STEPS_KM[0] as number;
  for (const step of GRID_STEPS_KM) {
    if (Math.abs((2 * halfKm) / step - GOOD_CELLS) < Math.abs((2 * halfKm) / best - GOOD_CELLS)) best = step;
  }
  return best;
}

/** Height of layer `index` of `count` (0 = oldest, at the bottom), centred on 0. */
export function layerZ(index: number, count: number, spacing: number): number {
  return (index - (count - 1) / 2) * spacing;
}

export interface Camera {
  /** Screen position (CSS px) and depth (larger = farther) of a point of the scene. */
  project(x: number, y: number, z: number): readonly [number, number, number];
  /** Sine of the tilt: how flat a circle on the ground looks. */
  readonly flatten: number;
  /** Changes whenever any projected point would: projections may be cached under it. */
  readonly key: string;
}

/** How far the eye is from the centre of the scene, in plate units: smaller is more perspective. */
export const EYE_DISTANCE = 3.6;

/** Where the scene sits on screen: px per plate unit at the centre, and the screen point of the origin. */
export interface Framing {
  readonly scale: number;
  readonly cx: number;
  readonly cy: number;
}

export interface CameraOptions {
  readonly yaw: number;
  readonly tilt: number;
  readonly width: number;
  readonly height: number;
  /** Default: a framing that fits a flat plate. */
  readonly framing?: Framing | undefined;
}

export function camera({ yaw, tilt, width, height, framing }: CameraOptions): Camera {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const sinE = Math.sin(tilt);
  const cosE = Math.cos(tilt);
  const { scale, cx, cy } = framing ?? { scale: Math.min(width / 3, height / 3.1), cx: width / 2, cy: height * 0.52 };
  return {
    flatten: sinE,
    key: `${yaw.toFixed(5)}|${tilt.toFixed(5)}|${scale.toFixed(3)}|${cx.toFixed(2)}|${cy.toFixed(2)}`,
    project(x, y, z) {
      // Yaw turns the plate; then the eye looks down at `tilt` from the south.
      const rx = x * cosY - y * sinY;
      const ry = x * sinY + y * cosY;
      const depth = EYE_DISTANCE + ry * cosE - z * sinE;
      const k = (scale * EYE_DISTANCE) / depth;
      return [cx + rx * k, cy - (ry * sinE + z * cosE) * k, depth];
    },
  };
}

/** Room kept around the plate for the north mark and the scale bar, in plate units. */
const FRAME_REACH = 1.3;

/**
 * The framing that makes the plate and its stack (from `groundZ` to `topZ`)
 * fill the stage at the given angle, with `margin` px left on each side.
 * Computed once for the default angle, so turning the plate never zooms.
 */
export function fitFraming(width: number, height: number, yaw: number, tilt: number, groundZ: number, topZ: number, margin = 26): Framing {
  const unit = camera({ yaw, tilt, width: 0, height: 0, framing: { scale: 1, cx: 0, cy: 0 } });
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [0, -FRAME_REACH],
    [0, FRAME_REACH],
    [-FRAME_REACH, 0],
    [FRAME_REACH, 0],
  ] as const) {
    for (const z of [groundZ, topZ]) {
      const [sx, sy] = unit.project(x, y, z);
      left = Math.min(left, sx);
      right = Math.max(right, sx);
      top = Math.min(top, sy);
      bottom = Math.max(bottom, sy);
    }
  }
  const scale = Math.max(1, Math.min((width - 2 * margin) / (right - left), (height - 2 * margin) / (bottom - top)));
  return { scale, cx: width / 2 - ((left + right) / 2) * scale, cy: height / 2 - ((top + bottom) / 2) * scale };
}

/** Indices of the layers from the farthest to the nearest, as the painter draws them. */
export function farToNear(zs: readonly number[], view: Camera): number[] {
  return zs
    .map((z, index) => ({ index, depth: view.project(0, 0, z)[2] }))
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map((one) => one.index);
}

/** Wraps an angle in radians to (-π, π]. */
export function wrapAngle(angle: number): number {
  const turned = (((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return turned - Math.PI;
}

/** Distance in px from a point to a segment on screen. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

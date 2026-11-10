/**
 * Paints one frame of the atlas on a 2D context (docs/PLAN.md, section 15).
 * It reads the scene it is given; the only thing it keeps is a cache of
 * projected points, keyed by the camera and the height, so a frame where
 * the camera did not move projects nothing again.
 *
 * Every stroke of a trace, every footprint and every head dot is the
 * projection of a point of the trimmed lines (or of a point on one of their
 * segments): nothing marks where a route starts or ends. Dates are written
 * beside the corner posts, never on the plate.
 */
import { distanceToSegment, gridStepKm, type Camera, type PlaneLine, type PlanePoint } from "./geometry";

/** The page's tokens in a form every canvas understands (src/styles.css). */
export const INK = {
  fg: "#f2edec",
  fg2: "#b7afae",
  fg3: "#998f8e",
  grid: "#3a302f",
  frame: "#5a4d4b",
  red: "#dd0011",
  redHi: "#ff534b",
  redDim: "#a3372f",
  muted: "#8a6b67",
  amber: "#e8aa4e",
} as const;

/** Stroke widths of a trace (before the depth cue): normal and selected. */
export const TRACE_WIDTH = 2.5;
export const SELECTED_WIDTH = 3.8;

export interface LayerScene {
  /** What is drawn of the trace now (all of it when complete: then the same array as `full`). */
  readonly lines: readonly PlaneLine[];
  /** The whole trace, for its footprint on the ground. */
  readonly full: readonly PlaneLine[];
  /** Where the stroke is while it draws itself; null when complete. Always on the trimmed lines. */
  readonly head: PlanePoint | null;
  readonly z: number;
  /** 0 for the oldest layer, 1 for the newest. */
  readonly age: number;
  /** 0 to 1: how much of the layer has risen into view. */
  readonly opacity: number;
  readonly selected: boolean;
  readonly dimmed: boolean;
  /** Short date written beside the layer's tick («18 abr»). */
  readonly label: string;
}

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly view: Camera;
  readonly layers: readonly LayerScene[];
  /** Height of the ground plate and of the top of the corner posts. */
  readonly groundZ: number;
  readonly topZ: number;
  /** Kilometres from the centre of the plate to its edge: sets the grid and its label. */
  readonly halfKm: number;
  /** Draw order of `layers`, far to near. */
  readonly order: readonly number[];
  /** Glow on the brightest strokes (off when frames would suffer). */
  readonly glow: boolean;
}

const CORNERS: readonly PlanePoint[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const hex = (value: string): number[] => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
const mix = (from: string, to: string, t: number): string => {
  const a = hex(from);
  const b = hex(to);
  return `rgb(${a.map((value, index) => Math.round(value + ((b[index] as number) - value) * t)).join(",")})`;
};
/** The colour of a layer, from dim red (oldest) to bright red (newest). */
export function rampColour(age: number): string {
  return mix(INK.redDim, INK.redHi, Math.max(0, Math.min(1, age)) ** 0.7);
}

// ---- projection cache ----
/** Per set of lines: the camera the entries belong to, and one entry per height (layer and ground). */
const cache = new WeakMap<readonly PlaneLine[], { camera: string; byHeight: Map<string, Float32Array[]> }>();

/** Screen points of `lines` at height z, as x, y pairs; reused while the camera and z are the same. */
function projected(view: Camera, lines: readonly PlaneLine[], z: number): Float32Array[] {
  let entry = cache.get(lines);
  if (entry === undefined || entry.camera !== view.key) {
    entry = { camera: view.key, byHeight: new Map() };
    cache.set(lines, entry);
  }
  const height = z.toFixed(5);
  const known = entry.byHeight.get(height);
  if (known !== undefined) return known;
  const points = lines.map((line) => {
    const out = new Float32Array(line.points.length * 2);
    line.points.forEach((point, index) => {
      const p = view.project(point[0], point[1], z);
      out[index * 2] = p[0];
      out[index * 2 + 1] = p[1];
    });
    return out;
  });
  entry.byHeight.set(height, points);
  return points;
}

function segment(context: CanvasRenderingContext2D, view: Camera, a: PlanePoint, b: PlanePoint, z: number, zb = z): void {
  const p = view.project(a[0], a[1], z);
  const q = view.project(b[0], b[1], zb);
  context.moveTo(p[0], p[1]);
  context.lineTo(q[0], q[1]);
}

function polyline(context: CanvasRenderingContext2D, view: Camera, points: readonly PlanePoint[], z: number): void {
  points.forEach((point, index) => {
    const p = view.project(point[0], point[1], z);
    if (index === 0) context.moveTo(p[0], p[1]);
    else context.lineTo(p[0], p[1]);
  });
}

/** The lines of one trace at height z: solid in `colour`, inferred stretches dashed amber. */
function strokeLines(context: CanvasRenderingContext2D, view: Camera, lines: readonly PlaneLine[], z: number, colour: string, width: number): void {
  const points = projected(view, lines, z);
  for (const inferred of [false, true]) {
    context.beginPath();
    let any = false;
    lines.forEach((line, index) => {
      const xy = points[index] as Float32Array;
      if ((line.inferred === true) !== inferred || xy.length < 4) return;
      context.moveTo(xy[0] as number, xy[1] as number);
      for (let at = 2; at < xy.length; at += 2) context.lineTo(xy[at] as number, xy[at + 1] as number);
      any = true;
    });
    if (!any) continue;
    context.strokeStyle = inferred ? INK.amber : colour;
    context.lineWidth = width;
    context.setLineDash(inferred ? [6, 5] : []);
    context.stroke();
  }
  context.setLineDash([]);
}

/** A layer's sheet: a faint fill, a thin outline and crop marks at its corners. */
function sheet(context: CanvasRenderingContext2D, view: Camera, z: number, strength: number, selected: boolean): void {
  const alpha = context.globalAlpha;
  context.beginPath();
  polyline(context, view, [...CORNERS, CORNERS[0] as PlanePoint], z);
  context.fillStyle = selected ? INK.redHi : INK.fg;
  context.globalAlpha = alpha * (selected ? 0.08 : 0.012 + 0.022 * strength);
  context.fill();
  context.strokeStyle = selected ? INK.fg : INK.fg3;
  context.lineWidth = 1;
  context.globalAlpha = alpha * (selected ? 0.55 : 0.08 + 0.14 * strength);
  context.stroke();
  // Crop marks at the four corners.
  context.beginPath();
  CORNERS.forEach((corner, index) => {
    const before = CORNERS[(index + 3) % 4] as PlanePoint;
    const after = CORNERS[(index + 1) % 4] as PlanePoint;
    const reach = 0.12;
    const a: PlanePoint = [corner[0] + (before[0] - corner[0]) * reach, corner[1] + (before[1] - corner[1]) * reach];
    const b: PlanePoint = [corner[0] + (after[0] - corner[0]) * reach, corner[1] + (after[1] - corner[1]) * reach];
    polyline(context, view, [a, corner, b], z);
  });
  context.strokeStyle = selected ? INK.fg : INK.fg3;
  context.lineWidth = selected ? 1.5 : 1;
  context.globalAlpha = alpha * (selected ? 0.95 : 0.35 + 0.35 * strength);
  context.stroke();
  context.globalAlpha = alpha;
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string, align: CanvasTextAlign, weight = 700): void {
  context.fillStyle = colour;
  context.font = `${weight} 11px Manrope, system-ui, sans-serif`;
  context.textAlign = align;
  context.textBaseline = "middle";
  context.fillText(text, x, y);
}

/** The ground: grid with a real scale, its frame, and the scale bar outside the near edge. */
function ground(context: CanvasRenderingContext2D, scene: Scene): void {
  const { view, groundZ, halfKm } = scene;
  const stepKm = gridStepKm(halfKm);
  const step = stepKm / halfKm;
  const lines = Math.floor(1 / step);
  context.lineWidth = 1;
  context.strokeStyle = INK.grid;
  context.beginPath();
  for (let g = -lines; g <= lines; g += 1) {
    const v = g * step;
    segment(context, view, [v, -1], [v, 1], groundZ);
    segment(context, view, [-1, v], [1, v], groundZ);
  }
  context.stroke();
  context.strokeStyle = INK.frame;
  context.beginPath();
  polyline(context, view, [...CORNERS, CORNERS[0] as PlanePoint], groundZ);
  context.stroke();
  // Scale bar: one grid cell, outside the south edge, with end ticks.
  const y = -1.1;
  context.strokeStyle = INK.fg2;
  context.lineWidth = 1.5;
  context.beginPath();
  segment(context, view, [-1, y], [-1 + step, y], groundZ);
  segment(context, view, [-1, y - 0.03], [-1, y + 0.03], groundZ);
  segment(context, view, [-1 + step, y - 0.03], [-1 + step, y + 0.03], groundZ);
  context.stroke();
  const text = view.project(-1 + step / 2, -1.22, groundZ);
  label(context, `${stepKm} km`, text[0], text[1], INK.fg2, "center");
}

/** Corner posts with one tick per layer, and the dates beside the nearest post. */
function posts(context: CanvasRenderingContext2D, scene: Scene): void {
  const { view, groundZ, topZ, layers } = scene;
  context.lineWidth = 1;
  context.strokeStyle = INK.frame;
  context.beginPath();
  for (const corner of CORNERS) segment(context, view, corner, corner, groundZ, topZ);
  context.stroke();
  const single = layers.some((layer) => layer.selected);
  const nearest = CORNERS.reduce((best, corner) => (view.project(corner[0], corner[1], 0)[2] < view.project(best[0], best[1], 0)[2] ? corner : best));
  context.lineWidth = 2;
  for (const layer of layers) {
    context.globalAlpha = layer.opacity * (layer.dimmed ? 0.5 : 1);
    context.strokeStyle = layer.selected ? INK.redHi : single ? INK.muted : rampColour(layer.age);
    context.beginPath();
    for (const corner of CORNERS) segment(context, view, corner, [corner[0] * 1.07, corner[1] * 1.07], layer.z);
    context.stroke();
  }
  // Dates beside the nearest post, from the top down, skipping any that would touch the one above.
  const marks = layers
    .map((layer) => ({ layer, at: view.project(nearest[0] * 1.1, nearest[1] * 1.1, layer.z) }))
    .sort((a, b) => a.at[1] - b.at[1] || (a.layer.selected ? -1 : 1));
  const side: CanvasTextAlign = view.project(nearest[0], nearest[1], 0)[0] < scene.width / 2 ? "right" : "left";
  const shift = side === "right" ? -4 : 4;
  let last = -Infinity;
  for (const { layer, at } of marks) {
    if (at[1] - last < 13 && !layer.selected) continue;
    last = at[1];
    context.globalAlpha = layer.opacity * (layer.dimmed ? 0.55 : 1);
    label(context, layer.label, at[0] + shift, at[1], layer.selected ? INK.fg : INK.fg3, side, layer.selected ? 800 : 600);
  }
  context.globalAlpha = 1;
}

export function paintScene(context: CanvasRenderingContext2D, scene: Scene, ratio: number): void {
  const { view, layers } = scene;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, scene.width, scene.height);
  context.lineJoin = "round";
  context.lineCap = "round";
  context.globalAlpha = 1;
  ground(context, scene);
  const single = layers.some((layer) => layer.selected);

  // Footprints: every trace, faint, on the ground; the selected one in bright red.
  for (const layer of layers) {
    context.globalAlpha = layer.opacity * (layer.selected ? 0.8 : single ? 0.07 : 0.13);
    strokeLines(context, view, layer.full, scene.groundZ, layer.selected ? INK.redHi : INK.fg2, layer.selected ? 1.6 : 1);
  }
  context.globalAlpha = 1;
  posts(context, scene);

  // Depth cue: the farthest layer a little dimmer and thinner than the nearest.
  const count = scene.order.length;
  scene.order.forEach((index, rank) => {
    const layer = layers[index];
    if (layer === undefined) return;
    const near = count > 1 ? rank / (count - 1) : 1;
    const { selected, dimmed } = layer;
    context.globalAlpha = layer.opacity;
    sheet(context, view, layer.z, Math.max(layer.age === 1 ? 1 : 0, near * 0.5), selected);
    const width = selected ? SELECTED_WIDTH : TRACE_WIDTH * (0.82 + 0.36 * near);
    const colour = selected ? INK.redHi : dimmed ? INK.muted : rampColour(layer.age);
    context.globalAlpha = layer.opacity * (dimmed ? 0.3 : 0.72 + 0.28 * near);
    const glowing = scene.glow && (selected || (!single && layer.age === 1));
    if (glowing) {
      // A halo: the same lines, wide and faint, under the stroke (cheaper than shadowBlur).
      const alpha = context.globalAlpha;
      context.globalAlpha = alpha * 0.22;
      strokeLines(context, view, layer.lines, layer.z, INK.red, width + 5);
      context.globalAlpha = alpha;
    }
    strokeLines(context, view, layer.lines, layer.z, colour, width);
    if (layer.head !== null) {
      const head = view.project(layer.head[0], layer.head[1], layer.z);
      context.globalAlpha = layer.opacity;
      context.fillStyle = INK.fg;
      context.beginPath();
      context.arc(head[0], head[1], selected ? 4 : 2.8, 0, Math.PI * 2);
      context.fill();
      if (selected) {
        // A drop line from the head to its footprint, and a ring there.
        const below = view.project(layer.head[0], layer.head[1], scene.groundZ);
        context.strokeStyle = INK.fg;
        context.lineWidth = 1;
        context.globalAlpha = 0.5;
        context.setLineDash([3, 4]);
        context.beginPath();
        context.moveTo(head[0], head[1]);
        context.lineTo(below[0], below[1]);
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;
        context.strokeStyle = INK.redHi;
        context.lineWidth = 1.5;
        context.beginPath();
        context.ellipse(below[0], below[1], 6, Math.max(1, 6 * view.flatten), 0, 0, Math.PI * 2);
        context.stroke();
      }
    }
  });
  context.globalAlpha = 1;

  // North: above the stack, outside the north edge, turning with the plate.
  context.strokeStyle = INK.redHi;
  context.lineWidth = 2;
  context.beginPath();
  segment(context, view, [0, 1.04], [0, 1.16], scene.topZ);
  context.stroke();
  const north = view.project(0, 1.27, scene.topZ);
  label(context, "N", north[0], north[1], INK.redHi, "center", 800);
}

/** The layer whose trace passes closest to a screen point, within `reach` px; -1 for none. */
export function pickLayer(scene: Scene, x: number, y: number, reach = 14): number {
  let best = -1;
  let bestDistance = reach;
  scene.layers.forEach((layer, index) => {
    for (const xy of projected(scene.view, layer.full, layer.z)) {
      for (let at = 2; at < xy.length; at += 2) {
        const distance = distanceToSegment(x, y, xy[at - 2] as number, xy[at - 1] as number, xy[at] as number, xy[at + 1] as number);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
  });
  return best;
}

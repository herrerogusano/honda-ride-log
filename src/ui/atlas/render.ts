/**
 * Paints one frame of the atlas on a 2D context (docs/PLAN.md, section 15).
 * Pure drawing: it reads the scene it is given and keeps nothing.
 *
 * Every stroke of a trace, every footprint and every head dot is the
 * projection of a point of the trimmed lines (or of a point on one of their
 * segments): nothing marks where a route starts or ends.
 */
import { distanceToSegment, gridStepKm, type Camera, type PlaneLine, type PlanePoint } from "./geometry";

/** The page's tokens in a form every canvas understands (src/styles.css). */
export const INK = {
  fg: "#f2edec",
  fg2: "#b7afae",
  fg3: "#998f8e",
  grid: "#2e2726",
  frame: "#4a3f3d",
  red: "#dd0011",
  redHi: "#ff534b",
  redDim: "#7a2a25",
  amber: "#e8aa4e",
} as const;

export interface LayerScene {
  /** What is drawn of the trace now (all of it when complete). */
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
}

const CORNERS: readonly PlanePoint[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const hex = (value: string): number[] => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));
/** The colour of a layer, from dim red (oldest) to bright red (newest). */
export function rampColour(age: number): string {
  const from = hex(INK.redDim);
  const to = hex(INK.redHi);
  const t = Math.max(0, Math.min(1, age)) ** 0.7;
  return `rgb(${from.map((value, index) => Math.round(value + ((to[index] as number) - value) * t)).join(",")})`;
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
  for (const inferred of [false, true]) {
    context.beginPath();
    let any = false;
    for (const line of lines) {
      if ((line.inferred === true) !== inferred || line.points.length < 2) continue;
      polyline(context, view, line.points, z);
      any = true;
    }
    if (!any) continue;
    context.strokeStyle = inferred ? INK.amber : colour;
    context.lineWidth = width;
    context.setLineDash(inferred ? [6, 5] : []);
    context.stroke();
  }
  context.setLineDash([]);
}

/** Crop marks at the four corners of a layer, instead of a full frame. */
function cropMarks(context: CanvasRenderingContext2D, view: Camera, z: number): void {
  context.beginPath();
  CORNERS.forEach((corner, index) => {
    const before = CORNERS[(index + 3) % 4] as PlanePoint;
    const after = CORNERS[(index + 1) % 4] as PlanePoint;
    const reach = 0.14;
    const a: PlanePoint = [corner[0] + (before[0] - corner[0]) * reach, corner[1] + (before[1] - corner[1]) * reach];
    const b: PlanePoint = [corner[0] + (after[0] - corner[0]) * reach, corner[1] + (after[1] - corner[1]) * reach];
    polyline(context, view, [a, corner, b], z);
  });
  context.stroke();
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string, align: CanvasTextAlign): void {
  context.fillStyle = colour;
  context.font = "700 11px Manrope, system-ui, sans-serif";
  context.textAlign = align;
  context.textBaseline = "middle";
  context.fillText(text, x, y);
}

/** The ground: grid with a real scale, its frame, the north mark, the scale bar and the corner posts. */
function ground(context: CanvasRenderingContext2D, scene: Scene): void {
  const { view, groundZ, topZ, halfKm } = scene;
  const stepKm = gridStepKm(halfKm);
  const step = stepKm / halfKm;
  const lines = Math.floor(1 / step);
  context.lineWidth = 1;
  context.strokeStyle = INK.grid;
  context.globalAlpha = 1;
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
  // Corner posts, from the ground to above the top layer.
  context.globalAlpha = 0.45;
  context.beginPath();
  for (const corner of CORNERS) segment(context, view, corner, corner, groundZ, topZ);
  context.stroke();
  context.globalAlpha = 1;
  // North: a mark on the plate's edge that turns with it.
  context.strokeStyle = INK.redHi;
  context.lineWidth = 2;
  context.beginPath();
  segment(context, view, [0, 1], [0, 1.16], groundZ);
  context.stroke();
  const north = view.project(0, 1.28, groundZ);
  label(context, "N", north[0], north[1], INK.redHi, "center");
  // Scale bar: one grid cell along the near-left edge.
  const from = view.project(-1, -1.1, groundZ);
  const to = view.project(-1 + step, -1.1, groundZ);
  context.strokeStyle = INK.fg3;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.lineTo(to[0], to[1]);
  context.stroke();
  const text = view.project(-1 + step / 2, -1.24, groundZ);
  label(context, `${stepKm} km`, text[0], text[1], INK.fg3, "center");
}

export function paintScene(context: CanvasRenderingContext2D, scene: Scene, ratio: number): void {
  const { view, layers } = scene;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, scene.width, scene.height);
  context.lineJoin = "round";
  context.lineCap = "round";
  ground(context, scene);
  const single = layers.some((layer) => layer.selected);

  // Footprints: every trace, faint, on the ground.
  for (const layer of layers) {
    context.globalAlpha = layer.opacity * (layer.selected ? 0.5 : single ? 0.06 : 0.16);
    strokeLines(context, view, layer.full, scene.groundZ, layer.selected ? INK.redHi : INK.fg2, 1);
  }

  // Ticks of each layer on the near-right post, in its colour.
  context.lineWidth = 2;
  for (const layer of layers) {
    context.globalAlpha = layer.opacity * (layer.dimmed ? 0.35 : 1);
    context.strokeStyle = layer.selected ? INK.redHi : rampColour(layer.age);
    context.beginPath();
    segment(context, view, [1, -1], [1.08, -1], layer.z);
    context.stroke();
  }

  for (const index of scene.order) {
    const layer = layers[index];
    if (layer === undefined) continue;
    const { selected, dimmed } = layer;
    context.lineWidth = 1;
    context.strokeStyle = selected ? INK.fg : INK.fg3;
    context.globalAlpha = layer.opacity * (selected ? 0.8 : dimmed ? 0.1 : 0.28);
    cropMarks(context, view, layer.z);
    context.globalAlpha = layer.opacity * (dimmed ? 0.24 : 1);
    strokeLines(context, view, layer.lines, layer.z, selected ? INK.redHi : rampColour(layer.age), selected ? 3 : single ? 1.4 : 2.1);
    if (layer.head !== null) {
      const head = view.project(layer.head[0], layer.head[1], layer.z);
      context.globalAlpha = layer.opacity;
      context.fillStyle = INK.fg;
      context.beginPath();
      context.arc(head[0], head[1], selected ? 4 : 2.6, 0, Math.PI * 2);
      context.fill();
      if (selected) {
        // A drop line from the head to its footprint, and a ring there.
        const below = view.project(layer.head[0], layer.head[1], scene.groundZ);
        context.strokeStyle = INK.fg;
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
  }
  context.globalAlpha = 1;
}

/** The layer whose drawn trace passes closest to a screen point, within `reach` px; -1 for none. */
export function pickLayer(scene: Scene, x: number, y: number, reach = 14): number {
  let best = -1;
  let bestDistance = reach;
  scene.layers.forEach((layer, index) => {
    for (const line of layer.full) {
      for (let at = 1; at < line.points.length; at += 1) {
        const a = line.points[at - 1] as PlanePoint;
        const b = line.points[at] as PlanePoint;
        const p = scene.view.project(a[0], a[1], layer.z);
        const q = scene.view.project(b[0], b[1], layer.z);
        const distance = distanceToSegment(x, y, p[0], p[1], q[0], q[1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
    }
  });
  return best;
}

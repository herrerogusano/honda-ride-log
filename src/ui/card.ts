/**
 * The card to share: figures only. No map, no coordinates, no speeds, no
 * dates of single rides, no vehicle data. It is drawn on a canvas, in the
 * look of the page (near-black, a red slanted wedge, numbered red tags,
 * Barlow Condensed for the title and the figures, Manrope for the labels),
 * and saved as PNG.
 *
 * The canvas is drawn at twice its size for sharpness. The page's own fonts
 * are loaded before drawing; if they do not arrive in time, the card is
 * drawn with the fallback fonts of the stack.
 */
import { formatKm, formatNumber, formatWholeKm, MONTHS_LONG, NBSP, withUnit } from "../domain/format";
import type { Route } from "../domain/model";
import { records, totals, type Period } from "../domain/stats";

export interface CardContent {
  readonly title: string;
  readonly items: readonly { readonly label: string; readonly value: string }[];
  /** True when the figures are synthetic: the card says so in large letters. */
  readonly demo: boolean;
  readonly fileName: string;
}

export function cardContent(routes: readonly Route[], period: Period, demo: boolean): CardContent {
  const sum = totals(routes);
  const best = records(routes);
  const month =
    best.bestMonth === null
      ? "—"
      : `${MONTHS_LONG[best.bestMonth.month]}${period === "all" ? ` de ${best.bestMonth.year}` : ""} · ${formatWholeKm(best.bestMonth.km)}`;
  return {
    title: period === "all" ? "Tu historial en moto" : `Tu ${period} en moto`,
    items: [
      { label: "Kilómetros", value: formatWholeKm(sum.km) },
      { label: "Salidas", value: formatNumber(sum.rides) },
      { label: "Horas en marcha", value: withUnit(formatNumber(sum.hours), "h") },
      { label: "Ruta más larga", value: best.longestRide === null ? "—" : formatKm(best.longestRide.km) },
      { label: "Mes con más km", value: month },
    ],
    demo,
    fileName: `ride-log-${period === "all" ? "historial" : period}${demo ? "-demo" : ""}.png`,
  };
}

/** One sentence with the same figures, for screen readers and as the canvas fallback. */
export function cardText(content: CardContent): string {
  const figures = content.items.map((item) => `${item.label}: ${item.value}`).join("; ");
  return `${content.title}${content.demo ? " (datos de ejemplo)" : ""}. ${figures}.`;
}

/** The card's size in its own units; the canvas holds twice as many pixels. */
export const CARD_SIZE = 1080;
export const CARD_SCALE = 2;

const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
const TEXT = '"Manrope", system-ui, "Segoe UI", sans-serif';
/** The faces the card uses, loaded before it is drawn. */
export const CARD_FONTS = [`800 100px ${DISPLAY}`, `700 100px ${DISPLAY}`, `700 20px ${TEXT}`, `500 20px ${TEXT}`] as const;

/** The page's colours (src/styles.css), as the canvas needs them. */
const INK = {
  bg: "#0d0a09",
  panel: "#16110f",
  line: "#2f2725",
  fg: "#f4efed",
  fg2: "#c4bab6",
  fg3: "#a99e9a",
  red: "#d6001c",
  redHi: "#ff4a4a",
  onRed: "#ffffff",
};

/** A value split before its unit («6.125» and «km»), so the unit can be small and red. */
export function splitUnit(value: string): [string, string] {
  const at = value.lastIndexOf(NBSP);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

/** Title in two lines: «TU 2026» / «EN MOTO». */
function titleLines(title: string): [string, string] {
  const at = title.toLowerCase().lastIndexOf(" en ");
  const upper = title.toUpperCase();
  return at < 0 ? [upper, ""] : [upper.slice(0, at), upper.slice(at + 1)];
}

/** A red tag with a slanted right edge and its number, like the section numbers of the page. */
function tag(context: CanvasRenderingContext2D, x: number, y: number, number: string): void {
  context.fillStyle = INK.red;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + 58, y);
  context.lineTo(x + 50, y + 36);
  context.lineTo(x, y + 36);
  context.closePath();
  context.fill();
  context.fillStyle = INK.onRed;
  context.font = `800 30px ${DISPLAY}`;
  context.fillText(number, x + 9, y + 30);
}

/** A figure with its unit small and red after it; shrinks to fit `max` wide. */
function figure(context: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, max: number): void {
  const [number, unit] = splitUnit(value);
  let scale = 1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    context.font = `700 ${Math.round(size * scale)}px ${DISPLAY}`;
    const numberWidth = context.measureText(number).width;
    context.font = `700 ${Math.round(size * scale * 0.4)}px ${DISPLAY}`;
    const unitWidth = unit === "" ? 0 : context.measureText(unit.toUpperCase()).width + size * scale * 0.08;
    if (numberWidth + unitWidth <= max) break;
    scale *= 0.88;
  }
  context.fillStyle = INK.fg;
  context.font = `700 ${Math.round(size * scale)}px ${DISPLAY}`;
  context.fillText(number, x, y);
  if (unit === "") return;
  const width = context.measureText(number).width;
  context.fillStyle = INK.redHi;
  context.font = `700 ${Math.round(size * scale * 0.4)}px ${DISPLAY}`;
  context.fillText(unit.toUpperCase(), x + width + size * scale * 0.08, y);
}

function label(context: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  context.fillStyle = INK.fg3;
  context.font = `700 20px ${TEXT}`;
  // Spaced capitals where the canvas knows letter spacing (Chrome, Firefox); plain capitals elsewhere.
  if ("letterSpacing" in context) context.letterSpacing = "3px";
  context.fillText(text.toUpperCase(), x, y);
  if ("letterSpacing" in context) context.letterSpacing = "0px";
}

/** Draws the card. Returns false when the browser gives no 2D canvas. */
export function drawCard(canvas: HTMLCanvasElement, content: CardContent): boolean {
  canvas.width = CARD_SIZE * CARD_SCALE;
  canvas.height = CARD_SIZE * CARD_SCALE;
  const context = canvas.getContext("2d");
  // Some environments answer undefined instead of null.
  if (context === null || context === undefined) return false;
  const S = CARD_SIZE;
  context.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, 0, 0);
  context.textBaseline = "alphabetic";

  context.fillStyle = INK.bg;
  context.fillRect(0, 0, S, S);
  // The red wedge on the right, slanted like the hero's.
  context.fillStyle = INK.red;
  context.beginPath();
  context.moveTo(S - 250, 0);
  context.lineTo(S, 0);
  context.lineTo(S, S);
  context.lineTo(S - 110, S);
  context.closePath();
  context.fill();
  // A thin red ruler under the title, like the section rule.
  const M = 72;
  context.fillStyle = INK.fg2;
  context.font = `800 26px ${DISPLAY}`;
  context.fillText("RIDE", M, 96);
  const ride = context.measureText("RIDE ").width;
  context.fillStyle = INK.redHi;
  context.fillText("LOG", M + ride, 96);

  const [first, second] = titleLines(content.title);
  context.fillStyle = INK.fg;
  context.font = `800 132px ${DISPLAY}`;
  context.fillText(first, M, 238, S - M - 300);
  context.fillStyle = INK.redHi;
  context.fillText(second, M, 352, S - M - 300);
  context.fillStyle = INK.red;
  context.fillRect(M, 384, 120, 4);

  // The kilometres, huge; then the other four figures, two by two.
  const [km, ...rest] = content.items;
  if (km !== undefined) {
    tag(context, M, 432, "01");
    label(context, km.label, M + 76, 459);
    figure(context, km.value, M, 610, 168, S - M - 300);
  }
  rest.forEach((item, index) => {
    const x = M + (index % 2) * 420;
    const y = 680 + Math.floor(index / 2) * 170;
    tag(context, x, y, String(index + 2).padStart(2, "0"));
    label(context, item.label, x + 76, y + 27);
    figure(context, item.value, x, y + 118, 84, 380);
  });

  context.fillStyle = INK.fg3;
  context.font = `500 20px ${TEXT}`;
  context.fillText("km según el servicio, unidades sin confirmar", M, S - 44, S - M - 260);
  if (content.demo) {
    // The demo mark: a black stamp on the wedge, in large letters.
    context.save();
    context.translate(S - 150, 210);
    context.rotate(Math.PI / 2);
    context.fillStyle = INK.bg;
    context.fillRect(-12, -46, 420, 64);
    context.fillStyle = INK.onRed;
    context.font = `800 44px ${DISPLAY}`;
    context.fillText("DATOS DE EJEMPLO", 0, 0, 400);
    context.restore();
  }
  return true;
}

export interface PaintOptions {
  /** Aborted when the page replaces the card: a late font load draws nothing. */
  readonly signal?: AbortSignal | undefined;
  /** How long to wait for the fonts before drawing with the fallbacks. */
  readonly fontTimeoutMs?: number;
}

/**
 * Draws the card once the page's fonts are ready (or after a timeout, with
 * the fallback fonts). Returns false at once when the browser gives no 2D
 * canvas; otherwise `drawn` is called after drawing.
 */
export function paintCard(canvas: HTMLCanvasElement, content: CardContent, drawn: () => void, options: PaintOptions = {}): boolean {
  const context = canvas.getContext("2d");
  if (context === null || context === undefined) return false;
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const go = (): void => {
    if (options.signal?.aborted === true) return;
    drawCard(canvas, content);
    drawn();
  };
  if (fonts === undefined || typeof fonts.load !== "function") {
    go();
    return true;
  }
  let timer = 0;
  const waited = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, options.fontTimeoutMs ?? 3000);
  });
  options.signal?.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
  void Promise.race([Promise.all(CARD_FONTS.map((font) => fonts.load(font))).then(() => undefined), waited])
    .catch(() => undefined)
    .then(() => {
      window.clearTimeout(timer);
      go();
    });
  return true;
}

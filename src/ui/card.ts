/**
 * The card to share: figures only. No map, no coordinates, no dates of
 * single rides, no vehicle data. It is drawn on a canvas and saved as PNG.
 */
import { formatKm, formatNumber, formatWholeKm, MONTHS_LONG, withUnit } from "../domain/format";
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

export const CARD_SIZE = 1080;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Draws the card. Returns false when the browser gives no 2D canvas. */
export function drawCard(canvas: HTMLCanvasElement, content: CardContent): boolean {
  canvas.width = CARD_SIZE;
  canvas.height = CARD_SIZE;
  const context = canvas.getContext("2d");
  // Some environments answer undefined instead of null.
  if (context === null || context === undefined) return false;

  context.fillStyle = "#12100f";
  context.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  // A slanted red band, the only ornament.
  context.fillStyle = "#dd0011";
  context.beginPath();
  context.moveTo(CARD_SIZE - 300, 0);
  context.lineTo(CARD_SIZE, 0);
  context.lineTo(CARD_SIZE, 230);
  context.lineTo(CARD_SIZE - 390, 230);
  context.closePath();
  context.fill();

  context.textBaseline = "alphabetic";
  context.fillStyle = "#f4f1ef";
  context.font = `700 76px ${FONT}`;
  context.fillText(content.title.toUpperCase(), 72, 170, CARD_SIZE - 480);

  let y = 330;
  for (const item of content.items) {
    context.fillStyle = "#b9b2ae";
    context.font = `700 30px ${FONT}`;
    context.fillText(item.label.toUpperCase(), 72, y);
    context.fillStyle = "#f4f1ef";
    context.font = `700 74px ${FONT}`;
    context.fillText(item.value, 72, y + 78, CARD_SIZE - 144);
    y += 138;
  }

  context.fillStyle = "#b9b2ae";
  context.font = `500 26px ${FONT}`;
  context.fillText("Ride Log · km según el servicio, unidades sin confirmar", 72, CARD_SIZE - 44, CARD_SIZE - 144);
  if (content.demo) {
    context.fillStyle = "#ffffff";
    context.font = `700 34px ${FONT}`;
    context.fillText("DATOS DE EJEMPLO", CARD_SIZE - 372, 200, 330);
  }
  return true;
}

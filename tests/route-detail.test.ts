// @vitest-environment jsdom
// Every listed or opened route shows all its useful information (owner's decision of 2026-11-10).
import { afterEach, describe, expect, it } from "vitest";
import { formatEndTime, formatInferred, formatSpeed } from "../src/domain/format";
import type { Route } from "../src/domain/model";
import type { ToolCaller } from "../src/service/contract";
import { cardContent, cardText } from "../src/ui/card";
import { buildRiderData, type RiderData } from "../src/ui/data";
import { createMapView, routeFacts } from "../src/ui/mapView";
import { renderRoutes, ROUTES_NOTE } from "../src/ui/routesView";
import { rides } from "./helpers";

const NOW = Date.parse("2026-11-09T20:00:00.000Z");

function riderData(routes: readonly Route[]): RiderData {
  const vehicle = { status: null, batteryPercent: null, lastCommunicationMs: null, odometer: null };
  return buildRiderData(vehicle, null, { routes, skipped: 0, requests: 1 }, true, NOW);
}

// Oldest first; the list shows the newest first.
const list = rides([
  // Starts at 23:30 in Los Angeles and ends after midnight.
  { start: "2026-03-07T23:30:00-08:00", km: 12.34, minutes: 50, speed: 31, maxSpeed: 74.6, inferred: true },
  // Nothing optional: no end, no speeds, no inferred flag.
  { start: "2026-03-09T07:05:00-07:00", km: 8, minutes: null, speed: null, maxSpeed: null, inferred: null },
  { start: "2026-03-10T10:00:00-07:00", km: 20, minutes: 30, speed: 40, maxSpeed: 0, inferred: false },
]);
const [overnight, bare, plain] = list as [Route, Route, Route];

afterEach(() => {
  document.body.replaceChildren();
});

function table(): { readonly head: string[]; readonly rows: string[][]; readonly root: HTMLElement } {
  const root = renderRoutes(riderData(list), () => undefined);
  document.body.append(root);
  const head = [...root.querySelectorAll("thead th")].map((cell) => cell.textContent ?? "");
  const rows = [...root.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );
  return { head, rows, root };
}

describe("the Rutas table", () => {
  it("has a column for every figure of a route", () => {
    expect(table().head).toEqual([
      "Fecha",
      "Salida",
      "Llegada",
      "Duración",
      "Km",
      "Vel. media (km/h)",
      "Vel. máx. (km/h)",
      "Tramos inferidos",
    ]);
  });

  it("writes the end time, the maximum speed and the inferred label of each route", () => {
    const { rows } = table();
    // Newest first: plain, bare, overnight.
    expect(rows[0]).toEqual(["10:00", "10:30", "30 min", "20,0", "40", "0", "No"]);
    expect(rows[2]).toEqual(["23:30", "00:20 (+1 día)", "50 min", "12,3", "31", "75", "Sí"]);
  });

  it("writes a dash for every figure the service did not send", () => {
    const { rows } = table();
    expect(rows[1]).toEqual(["07:05", "—", "—", "8,0", "—", "—", "—"]);
  });

  it("says under the list that both speeds have unconfirmed units and what the inferred label means", () => {
    const { root } = table();
    const note = root.querySelector(".notes")?.textContent ?? "";
    expect(note).toBe(ROUTES_NOTE);
    expect(note).toContain("velocidades media y máxima");
    expect(note).toContain("sin confirmar");
    expect(note).toContain("no una garantía de precisión");
  });

  it("offers the maximum speed as a sort order and applies it", () => {
    const { root } = table();
    const select = root.querySelector("select") as HTMLSelectElement;
    const option = [...select.options].find((one) => one.value === "max_speed_desc");
    expect(option?.textContent).toBe("Vel. máxima, de mayor a menor");
    // jsdom has no layout: the option must not be longer than the longest one that already fitted at 320 px.
    const longest = Math.max(...[...select.options].filter((one) => one !== option).map((one) => (one.textContent ?? "").length));
    expect((option?.textContent ?? "").length).toBeLessThanOrEqual(longest);
    select.value = "max_speed_desc";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const maxima = [...root.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[5]?.textContent);
    expect(maxima).toEqual(["75", "0", "—"]);
  });
});

describe("the Mapa description of the open route", () => {
  const never: ToolCaller = { callTool: () => new Promise<never>(() => undefined) };

  function opened(route: Route): string {
    const view = createMapView(riderData(list), never, { signIn: null }, () => ({
      show: () => undefined,
      clear: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    }));
    document.body.replaceChildren(view.element);
    view.open(route);
    return document.querySelector(".map-view .lead")?.textContent ?? "";
  }

  it("shows the same figures as the list", () => {
    expect(opened(overnight)).toBe(
      "Salida: 23:30 · Llegada: 00:20 (+1 día) · Duración: 50 min · 12,3 km · Vel. media: 31 km/h · Vel. máxima: 75 km/h · Tramos inferidos: Sí",
    );
    expect(opened(plain)).toBe(
      "Salida: 10:00 · Llegada: 10:30 · Duración: 30 min · 20,0 km · Vel. media: 40 km/h · Vel. máxima: 0 km/h · Tramos inferidos: No",
    );
    expect(opened(overnight)).toBe(routeFacts(overnight));
  });

  it("writes a dash for every figure the service did not send", () => {
    expect(opened(bare)).toBe(
      "Salida: 07:05 · Llegada: — · Duración: — · 8,0 km · Vel. media: — · Vel. máxima: — · Tramos inferidos: —",
    );
  });

  it("says in the legend that both speeds have unconfirmed units", () => {
    opened(plain);
    const legend = document.querySelector(".map-legend")?.textContent ?? "";
    expect(legend).toContain("velocidades media y máxima");
    expect(legend).toContain("sin confirmar");
  });
});

describe("the share card", () => {
  it("never carries the maximum speed: the card leaves the site", () => {
    const fast = rides([{ start: "2026-03-07T10:00:00-08:00", km: 40, speed: 33, maxSpeed: 987 }]);
    const content = cardContent(fast, 2026, false);
    const all = `${cardText(content)} ${JSON.stringify(content)}`;
    expect(all).not.toContain("987");
    expect(all.toLowerCase()).not.toMatch(/máx|velocidad|km\/h/);
  });
});

describe("the new figures' texts", () => {
  it("counts the days an end time adds, by local calendar day", () => {
    const start = Date.parse("2026-03-07T23:30:00-08:00");
    expect(formatEndTime(start, null)).toBe("—");
    expect(formatEndTime(start, start)).toBe("23:30");
    expect(formatEndTime(start, Date.parse("2026-03-07T23:59:00-08:00"))).toBe("23:59");
    expect(formatEndTime(start, Date.parse("2026-03-08T00:00:00-08:00"))).toBe("00:00 (+1 día)");
    // Across the start of daylight saving in Los Angeles (8 March 2026, 02:00).
    expect(formatEndTime(start, Date.parse("2026-03-09T09:00:00-07:00"))).toBe("09:00 (+2 días)");
  });

  it("labels speeds in km/h and the inferred flag without claiming accuracy", () => {
    expect(formatSpeed(null)).toBe("—");
    expect(formatSpeed(0)).toBe("0 km/h");
    expect(formatSpeed(104.6)).toBe("105 km/h");
    expect(formatSpeed(1234)).toBe("1.234 km/h");
    expect([true, false, null].map(formatInferred)).toEqual(["Sí", "No", "—"]);
  });
});

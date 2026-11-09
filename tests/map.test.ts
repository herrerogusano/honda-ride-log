// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import type { LatLng, TraceLine } from "../src/domain/model";
import { distanceMeters } from "../src/domain/trim";
import { ToolCallError, type RawRouteDetail, type ToolCaller, type ToolName } from "../src/service/contract";
import { loadAllRoutes, loadVehicleState } from "../src/service/loader";
import { buildRiderData, type RiderData } from "../src/ui/data";
import { createLeafletSurface, TILE_URL, type MapSurface } from "../src/ui/leafletSurface";
import { createMapView, type MapView } from "../src/ui/mapView";

const NOW = Date.parse("2026-11-09T20:00:00.000Z");
const rider = generateRider({ seed: 8, nowMs: NOW });

interface Harness {
  readonly view: MapView;
  readonly data: RiderData;
  readonly calls: ToolName[];
  /** Every set of lines handed to the map, in order. */
  readonly shown: (readonly TraceLine[])[];
  readonly surfaces: () => number;
  readonly cleared: () => number;
  readonly resized: () => number;
}

/** A map view over the demo rider, with a surface that records instead of drawing. */
async function harness(change?: (name: ToolName, args: unknown, answer: () => Promise<unknown>) => Promise<unknown>): Promise<Harness> {
  const service = createDemoService(rider);
  const calls: ToolName[] = [];
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push(name);
      const answer = (): Promise<unknown> => service.callTool(name, args);
      return change ? change(name, args, answer) : answer();
    },
  };
  const data = buildRiderData(await loadVehicleState(service), null, await loadAllRoutes(service, NOW), true, NOW);
  const shown: (readonly TraceLine[])[] = [];
  let surfaces = 0;
  let cleared = 0;
  let resized = 0;
  const surface: MapSurface = {
    show: (lines) => void shown.push(lines),
    clear: () => void (cleared += 1),
    resize: () => void (resized += 1),
  };
  const view = createMapView(data, caller, () => {
    surfaces += 1;
    return surface;
  });
  document.body.replaceChildren(view.element);
  return { view, data, calls, shown, surfaces: () => surfaces, cleared: () => cleared, resized: () => resized };
}

const text = (): string => document.body.textContent ?? "";
const canvas = (): HTMLElement => document.querySelector(".map-canvas") as HTMLElement;
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll("button")].find((one) => (one.textContent ?? "").includes(label)) as HTMLButtonElement;

function pathLength(lines: readonly TraceLine[]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i += 1) total += distanceMeters(line.points[i - 1] as LatLng, line.points[i] as LatLng);
  }
  return total;
}

function rawLines(detail: RawRouteDetail): TraceLine[] {
  return (detail.geojson?.features ?? []).flatMap((feature) =>
    feature.geometry.type === "LineString"
      ? [{ inferred: feature.properties.inferred ?? null, points: feature.geometry.coordinates.map(([lon, lat]): LatLng => [lat, lon]) }]
      : [],
  );
}

/** A detail whose only line runs `metres` north from a made-up point. */
function straightDetail(metres: number): unknown {
  const metresPerDegree = (Math.PI * 6_371_008.8) / 180;
  return {
    geojson: {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [[-1, 40, 0], [-1, 40 + metres / metresPerDegree, 0]] }, properties: { inferred: false } }],
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("Mapa tab", () => {
  it("asks for nothing and creates no map until a route is opened", async () => {
    const h = await harness();
    expect(h.calls).toEqual([]);
    expect(h.surfaces()).toBe(0);
    expect(canvas().hidden).toBe(true);
    expect(text()).toContain("Elige una ruta en la pestaña Rutas");
    h.view.shown();
    expect(h.resized()).toBe(0);
  });

  it("requests the opened route once and draws only its trimmed lines", async () => {
    const h = await harness();
    const route = h.data.routes.reduce((a, b) => (b.distanceKm > a.distanceKm ? b : a));
    const rawRoute = rider.routes.reduce((a, b) => ((b.distance_km ?? 0) > (a.distance_km ?? 0) ? b : a));
    h.view.open(route);
    expect(text()).toContain("Cargando el recorrido");
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(h.calls).toEqual(["get_route_detail"]);
    expect(canvas().hidden).toBe(false);

    const raw = rawLines(rider.detail(rawRoute.route_id) as RawRouteDetail);
    const drawn = h.shown[0] as readonly TraceLine[];
    // 400 m are missing from each end, and the exact ends are never handed to the map.
    expect(Math.abs(pathLength(drawn) - (pathLength(raw) - 800))).toBeLessThan(0.5);
    const start = raw[0]?.points[0] as LatLng;
    const end = raw[raw.length - 1]?.points.slice(-1)[0] as LatLng;
    const first = drawn[0]?.points[0] as LatLng;
    const last = drawn[drawn.length - 1]?.points.slice(-1)[0] as LatLng;
    expect(distanceMeters(start, first)).toBeGreaterThan(1);
    expect(distanceMeters(end, last)).toBeGreaterThan(1);
    for (const line of drawn) for (const point of line.points) expect([start, end]).not.toContainEqual(point);
    expect(text()).toContain("Recorrido dibujado en el mapa");

    // Opening it again uses what is in memory.
    h.view.open(route);
    expect(h.shown.length).toBe(2);
    expect(h.calls).toEqual(["get_route_detail"]);
    expect(h.surfaces()).toBe(1);
    h.view.shown();
    expect(h.resized()).toBe(1);
  });

  it("passes on which lines the service marks as inferred", async () => {
    const h = await harness();
    const index = rider.routes.findIndex(
      (route) => route.has_inferred_segments === true && (route.distance_km ?? 0) > 5 && rawLines(rider.detail(route.route_id) as RawRouteDetail).length === 2,
    );
    const start = Date.parse(rider.routes[index]?.started_at as string);
    h.view.open(h.data.routes.find((route) => route.startMs === start) as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(h.shown[0]?.map((line) => line.inferred)).toEqual([true, false]);
    expect(text()).toContain("con tramos marcados como inferidos");
  });

  it("says the trace is hidden for privacy when the trim leaves nothing", async () => {
    const h = await harness(async (name, _args, answer) => (name === "get_route_detail" ? straightDetail(700) : answer()));
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(text()).toContain("Traza oculta por privacidad"));
    expect(h.shown).toEqual([]);
    expect(h.surfaces()).toBe(0);
    expect(canvas().hidden).toBe(true);
  });

  it("clears the previous drawing before showing a route with a hidden trace", async () => {
    let short = false;
    const h = await harness(async (name, _args, answer) => (name === "get_route_detail" && short ? straightDetail(700) : answer()));
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    short = true;
    h.view.open(h.data.routes[1] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(text()).toContain("Traza oculta por privacidad"));
    expect(h.cleared()).toBeGreaterThan(0);
    expect(canvas().hidden).toBe(true);
    expect(h.shown.length).toBe(1);
  });

  it("says so when the service sends no trace at all", async () => {
    const h = await harness(async (name, _args, answer) => (name === "get_route_detail" ? { geojson: null } : answer()));
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(text()).toContain("El servicio no ha enviado el recorrido de esta ruta."));
    expect(text()).not.toContain("Traza oculta");
    expect(canvas().hidden).toBe(true);
  });

  it("shows a failed request with its code and retries on demand", async () => {
    let fail = true;
    const h = await harness(async (name, _args, answer) => {
      if (name === "get_route_detail" && fail) throw new ToolCallError("upstream_unavailable", "private text");
      return answer();
    });
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"] code')?.textContent).toBe("detail/tool_error (upstream_unavailable)");
    expect(text()).toContain("No se ha podido cargar el recorrido de esta ruta.");
    expect(text()).not.toContain("private text");
    expect(canvas().hidden).toBe(true);
    fail = false;
    button("Reintentar").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(h.calls).toEqual(["get_route_detail", "get_route_detail"]);
  });

  it("draws only the route opened last when an older answer arrives late", async () => {
    let releaseFirst: () => void = () => undefined;
    let requests = 0;
    const h = await harness(async (name, _args, answer) => {
      if (name !== "get_route_detail") return answer();
      requests += 1;
      if (requests === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return answer();
    });
    const [older, newer] = [h.data.routes[10], h.data.routes[11]] as [RiderData["routes"][number], RiderData["routes"][number]];
    h.view.open(older);
    h.view.open(newer);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    const drawnForNewer = h.shown[0];
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.shown.length).toBe(1);
    expect(h.shown[0]).toBe(drawnForNewer);
    expect(document.querySelector("h3")?.textContent).toContain(String(new Date(newer.startMs).getDate()));
    // The late answer was still kept, so going back does not ask again.
    h.view.open(older);
    expect(h.shown.length).toBe(2);
    expect(requests).toBe(2);
  });

  it("steps to the previous and the next route by date, and stops at both ends", async () => {
    const h = await harness();
    const routes = h.data.routes;
    h.view.open(routes[0] as RiderData["routes"][number]);
    expect(button("Ruta anterior").disabled).toBe(true);
    expect(button("Ruta siguiente").disabled).toBe(false);
    button("Ruta siguiente").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(h.calls.length).toBe(2);
    expect(button("Ruta anterior").disabled).toBe(false);
    button("Ruta anterior").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(2));
    expect(button("Ruta anterior").disabled).toBe(true);
    h.view.open(routes[routes.length - 1] as RiderData["routes"][number]);
    expect(button("Ruta siguiente").disabled).toBe(true);
  });

  it("explains the dashed line and the trim in a legend", async () => {
    await harness();
    const legend = document.querySelector(".map-legend")?.textContent ?? "";
    expect(legend).toContain("Es una etiqueta descriptiva, no una garantía de precisión.");
    expect(legend).toContain("No se dibujan los primeros ni los últimos 400 m de cada ruta, ni marcadores de inicio o de fin.");
  });
});

describe("Leaflet surface", () => {
  it("uses OpenStreetMap tiles with a visible attribution and draws lines without markers", () => {
    expect(TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    const container = document.createElement("div");
    document.body.append(container);
    const surface = createLeafletSurface(container);
    surface.show([
      { inferred: true, points: [[40.3, -1.1], [40.31, -1.1]] },
      { inferred: false, points: [[40.31, -1.1], [40.33, -1.08]] },
    ]);
    expect(container.classList.contains("leaflet-container")).toBe(true);
    const attribution = container.querySelector(".leaflet-control-attribution");
    expect(attribution?.textContent).toBe("© colaboradores de OpenStreetMap");
    expect(attribution?.querySelector("a")?.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(container.querySelectorAll(".leaflet-marker-icon").length).toBe(0);
    expect([...container.querySelectorAll("path")].map((path) => path.getAttribute("class"))).toEqual([
      "trace-casing",
      "trace trace-inferred",
      "trace-casing",
      "trace",
    ]);
    expect([container.querySelector(".leaflet-control-zoom-in")?.getAttribute("title"), container.querySelector(".leaflet-control-zoom-out")?.getAttribute("title")]).toEqual(["Acercar", "Alejar"]);
    for (const tile of container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")) {
      expect(tile.src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    }
    surface.clear();
    expect(container.querySelectorAll("path").length).toBe(0);
    surface.resize();
  });
});

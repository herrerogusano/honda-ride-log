// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoService } from "../src/demo/fakeService";
import { generateRider } from "../src/demo/generator";
import { formatDateLong, formatDuration, formatEndTime, formatInferred, formatKm, formatSpeed, formatTime } from "../src/domain/format";
import type { LatLng, TraceLine } from "../src/domain/model";
import { distanceMeters } from "../src/domain/trim";
import { ToolCallError, type RawRouteDetail, type ToolCaller, type ToolName } from "../src/service/contract";
import { loadAllRoutes, loadVehicleState } from "../src/service/loader";
import { ServiceError } from "../src/service/mcpClient";
import { buildRiderData, type RiderData } from "../src/ui/data";
import { createLeafletSurface, PolicyFriendlyTiles, TILE_URL, type MapSurface } from "../src/ui/leafletSurface";
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
  readonly destroyed: () => number;
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
  let destroyed = 0;
  const surface: MapSurface = {
    show: (lines) => void shown.push(lines),
    clear: () => void (cleared += 1),
    resize: () => void (resized += 1),
    destroy: () => void (destroyed += 1),
  };
  const view = createMapView(data, caller, { signIn: null }, () => {
    surfaces += 1;
    return surface;
  });
  document.body.replaceChildren(view.element);
  return { view, data, calls, shown, surfaces: () => surfaces, cleared: () => cleared, resized: () => resized, destroyed: () => destroyed };
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
    expect(text()).toContain("Elige una ruta en la lista de abajo");
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
    // Nothing within 400 m of either end is handed to the map.
    expect(pathLength(drawn)).toBeLessThan(pathLength(raw) - 800);
    expect(pathLength(drawn)).toBeGreaterThan(pathLength(raw) / 2);
    const start = raw[0]?.points[0] as LatLng;
    const end = raw[raw.length - 1]?.points.slice(-1)[0] as LatLng;
    for (const line of drawn) {
      for (const point of line.points) {
        expect(distanceMeters(point, start)).toBeGreaterThanOrEqual(400);
        expect(distanceMeters(point, end)).toBeGreaterThanOrEqual(400);
      }
    }
    expect(text()).toContain("Recorrido dibujado en el mapa");

    // Opening it again uses what is in memory.
    h.view.open(route);
    await vi.waitFor(() => expect(h.shown.length).toBe(2));
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
    // Cleared when the route was opened and again when its trace turned out to be hidden.
    expect(h.cleared()).toBe(2);
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
    h.view.open(h.data.routes[2] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"] code')?.textContent).toBe("detail/tool_error (upstream_unavailable)");
    expect(text()).toContain("No se ha podido cargar el recorrido de esta ruta.");
    expect(text()).not.toContain("private text");
    expect(canvas().hidden).toBe(true);
    fail = false;
    button("Reintentar").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(document.querySelector("h3")?.textContent).toBe(`Ruta del ${formatDateLong((h.data.routes[2] as RiderData["routes"][number]).startMs)}`);
    expect(h.shown[0]?.length).toBeGreaterThan(0);
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
    expect(document.querySelector("h3")?.textContent).toBe(`Ruta del ${formatDateLong(newer.startMs)}`);
    // The late answer was still kept, so going back does not ask again.
    h.view.open(older);
    await vi.waitFor(() => expect(h.shown.length).toBe(2));
    expect(requests).toBe(2);
  });

  it("does not show the error of a route the user has already left", async () => {
    let failFirst: () => void = () => undefined;
    let requests = 0;
    const h = await harness(async (name, _args, answer) => {
      if (name !== "get_route_detail") return answer();
      requests += 1;
      if (requests === 1) await new Promise<void>((_resolve, reject) => (failFirst = () => reject(new ToolCallError("upstream_unavailable", "x"))));
      return answer();
    });
    h.view.open(h.data.routes[10] as RiderData["routes"][number]);
    h.view.open(h.data.routes[11] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    failFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(canvas().hidden).toBe(false);
  });

  it("asks once for a route opened again while its answer is on the way", async () => {
    const release: (() => void)[] = [];
    const h = await harness(async (name, _args, answer) => {
      if (name === "get_route_detail") await new Promise<void>((resolve) => release.push(resolve));
      return answer();
    });
    const [a, b] = [h.data.routes[3], h.data.routes[4]] as [RiderData["routes"][number], RiderData["routes"][number]];
    h.view.open(a);
    h.view.open(a);
    h.view.open(b);
    h.view.open(a);
    expect(h.calls).toEqual(["get_route_detail", "get_route_detail"]);
    for (const go of release) go();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(document.querySelector("h3")?.textContent).toBe(`Ruta del ${formatDateLong(a.startMs)}`);
    // One request per route, however many times each was opened.
    expect(h.calls.length).toBe(2);
  });

  it("shows an error with a retry, never a blank tab, when drawing itself fails", async () => {
    const service = createDemoService(rider);
    const data = buildRiderData(await loadVehicleState(service), null, await loadAllRoutes(service, NOW), true, NOW);
    let broken = true;
    const shown: unknown[] = [];
    const view = createMapView(data, service, { signIn: null }, () => {
      if (broken) throw new Error("map library failed");
      return { show: (lines) => void shown.push(lines), clear: () => undefined, resize: () => undefined, destroy: () => undefined };
    });
    document.body.replaceChildren(view.element);
    view.open(data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"] code')?.textContent).toBe("detail/unknown");
    expect(canvas().hidden).toBe(true);
    expect(text()).not.toContain("map library failed");
    broken = false;
    button("Reintentar").click();
    await vi.waitFor(() => expect(shown.length).toBe(1));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(canvas().hidden).toBe(false);
  });

  it("steps to the previous and the next route by date, and stops at both ends", async () => {
    const h = await harness();
    const routes = h.data.routes;
    h.view.open(routes[0] as RiderData["routes"][number]);
    expect(button("Ruta anterior").disabled).toBe(true);
    expect(button("Ruta siguiente").disabled).toBe(false);
    expect(button("Ruta siguiente").parentElement?.hidden).toBe(false);
    button("Ruta siguiente").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(document.querySelector("h3")?.textContent).toBe(`Ruta del ${formatDateLong((routes[1] as RiderData["routes"][number]).startMs)}`);
    expect(h.calls.length).toBe(2);
    expect(button("Ruta anterior").disabled).toBe(false);
    button("Ruta anterior").click();
    await vi.waitFor(() => expect(h.shown.length).toBe(2));
    expect(document.querySelector("h3")?.textContent).toBe(`Ruta del ${formatDateLong((routes[0] as RiderData["routes"][number]).startMs)}`);
    expect(button("Ruta anterior").disabled).toBe(true);
    h.view.open(routes[routes.length - 1] as RiderData["routes"][number]);
    expect(button("Ruta siguiente").disabled).toBe(true);
  });

  it("writes the date and every figure of the open route", async () => {
    const h = await harness();
    const route = h.data.routes[5] as RiderData["routes"][number];
    expect(button("Ruta siguiente").parentElement?.hidden).toBe(true);
    h.view.open(route);
    expect(document.querySelector(".map-view .lead")?.textContent).toBe(
      [
        `Salida: ${formatTime(route.startMs)}`,
        `Llegada: ${formatEndTime(route.startMs, route.endMs)}`,
        `Duración: ${formatDuration(route.durationS)}`,
        formatKm(route.distanceKm),
        `Vel. media: ${formatSpeed(route.averageSpeed)}`,
        `Vel. máxima: ${formatSpeed(route.maxSpeed)}`,
        `Tramos inferidos: ${formatInferred(route.hasInferredSegments)}`,
      ].join(" · "),
    );
    expect(route.maxSpeed).not.toBeNull();
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(text()).not.toContain("Cargando el recorrido");
  });

  it("clears the previous drawing while the next route is loading, and on an error", async () => {
    let fail = false;
    let release: () => void = () => undefined;
    const h = await harness(async (name, _args, answer) => {
      if (name !== "get_route_detail") return answer();
      if (fail) {
        await new Promise<void>((resolve) => (release = resolve));
        throw new ToolCallError("upstream_unavailable", "x");
      }
      return answer();
    });
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    expect(h.cleared()).toBe(0);
    fail = true;
    h.view.open(h.data.routes[1] as RiderData["routes"][number]);
    expect(h.cleared()).toBe(1);
    expect(text()).toContain("Cargando el recorrido…");
    release();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(canvas().hidden).toBe(true);
    expect(text()).not.toContain("Cargando el recorrido");
    // Cleared when the next route was opened and again when it failed.
    expect(h.cleared()).toBe(2);
  });

  it("announces its messages in a live region that exists from the start", async () => {
    const h = await harness();
    const status = document.querySelector(".map-status") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    expect(document.querySelector(".map-status")).toBe(status);
    expect(status.textContent).toBe("Cargando el recorrido…");
    await vi.waitFor(() => expect(status.textContent).toContain("Recorrido dibujado en el mapa"));
  });

  it("releases its map and draws nothing afterwards", async () => {
    let release: () => void = () => undefined;
    let hold = false;
    const h = await harness(async (name, _args, answer) => {
      if (name === "get_route_detail" && hold) await new Promise<void>((resolve) => (release = resolve));
      return answer();
    });
    h.view.open(h.data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    hold = true;
    h.view.open(h.data.routes[1] as RiderData["routes"][number]);
    h.view.destroy();
    expect(h.destroyed()).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.shown.length).toBe(1);
    expect(h.surfaces()).toBe(1);
  });

  it("forgets every trace it kept once released, the late ones too", async () => {
    let release: () => void = () => undefined;
    let hold = false;
    const h = await harness(async (name, _args, answer) => {
      if (name === "get_route_detail" && hold) await new Promise<void>((resolve) => (release = resolve));
      return answer();
    });
    const [first, second] = h.data.routes as RiderData["routes"];
    h.view.open(first as RiderData["routes"][number]);
    await vi.waitFor(() => expect(h.shown.length).toBe(1));
    hold = true;
    h.view.open(second as RiderData["routes"][number]);
    h.view.destroy();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold = false;
    // Opened again (only a test does this), both are asked for again: nothing was kept.
    h.view.open(first as RiderData["routes"][number]);
    h.view.open(second as RiderData["routes"][number]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls.filter((name) => name === "get_route_detail")).toHaveLength(4);
  });

  it("offers a new sign-in instead of a retry when the session is over", async () => {
    const service = createDemoService(rider);
    const data = buildRiderData(await loadVehicleState(service), null, await loadAllRoutes(service, NOW), false, NOW);
    const ended: ToolCaller = { callTool: async () => Promise.reject(new ServiceError("reauth_required", "expired")) };
    const surface: MapSurface = { show: () => undefined, clear: () => undefined, resize: () => undefined, destroy: () => undefined };
    let signIns = 0;
    const view = createMapView(data, ended, { signIn: () => void (signIns += 1) }, () => surface);
    document.body.replaceChildren(view.element);
    view.open(data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(text()).toContain("detail/reauth_required (expired)"));
    expect(button("Reintentar")).toBeUndefined();
    button("Volver a entrar").click();
    expect(signIns).toBe(1);

    // Without a way to sign in (the demo), no button at all.
    const bare = createMapView(data, ended, { signIn: null }, () => surface);
    document.body.replaceChildren(bare.element);
    bare.open(data.routes[0] as RiderData["routes"][number]);
    await vi.waitFor(() => expect(text()).toContain("detail/reauth_required (expired)"));
    expect(document.querySelectorAll(".map-status button")).toHaveLength(0);
  });

  it("explains the dotted line and the hidden surroundings in a legend", async () => {
    await harness();
    const legend = document.querySelector(".map-legend")?.textContent ?? "";
    expect(legend).toContain("Es una etiqueta descriptiva, no una garantía de precisión.");
    expect(legend).toContain("No se dibuja nada a menos de 400 m de donde empieza o acaba cada ruta");
    expect(legend).toContain("ni marcadores de inicio o de fin.");
  });
});

describe("Leaflet surface", () => {
  const LINES: TraceLine[] = [
    { inferred: true, points: [[40.3, -1.1], [40.31, -1.1]] },
    { inferred: false, points: [[40.31, -1.1], [40.33, -1.08]] },
  ];
  /** jsdom lays nothing out: give the container the size a browser would. */
  function sized(width: number, height: number): HTMLElement {
    const container = document.createElement("div");
    let size = [width, height];
    Object.defineProperty(container, "clientWidth", { get: () => size[0] });
    Object.defineProperty(container, "clientHeight", { get: () => size[1] });
    Object.defineProperty(container, "resizeTo", { value: (w: number, h: number) => (size = [w, h]) });
    document.body.append(container);
    return container;
  }
  const classes = (container: HTMLElement): (string | null)[] => [...container.querySelectorAll("path")].map((path) => path.getAttribute("class"));

  it("uses OpenStreetMap tiles with a visible attribution and draws lines without markers", () => {
    expect(TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    const container = sized(600, 400);
    const surface = createLeafletSurface(container);
    // Nothing is requested before there is a route to frame.
    expect(container.querySelectorAll("img.leaflet-tile").length).toBe(0);
    surface.show(LINES);
    expect(container.classList.contains("leaflet-container")).toBe(true);
    const attribution = container.querySelector(".leaflet-control-attribution");
    expect(attribution?.textContent).toBe("© colaboradores de OpenStreetMap");
    expect(attribution?.querySelector("a")?.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    // The link opens apart and tells the other site nothing about this page.
    expect([attribution?.querySelector("a")?.getAttribute("target"), attribution?.querySelector("a")?.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    expect(container.querySelectorAll(".leaflet-control-attribution").length).toBe(1);
    expect(container.querySelectorAll(".leaflet-marker-icon").length).toBe(0);
    expect(classes(container)).toEqual(["trace-casing", "trace trace-inferred", "trace-casing", "trace"]);
    expect([container.querySelector(".leaflet-control-zoom-in")?.getAttribute("title"), container.querySelector(".leaflet-control-zoom-out")?.getAttribute("title")]).toEqual(["Acercar", "Alejar"]);
    const tiles = [...container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(tile.src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
    // Framed on the route: a zoom at which two kilometres fill a good part of the map.
    const zoom = Number(tiles[0]?.src.split("/")[3]);
    expect(zoom).toBeGreaterThanOrEqual(12);
    expect(zoom).toBeLessThanOrEqual(16);

    // A second route replaces the first instead of piling up on it.
    surface.show([LINES[1] as TraceLine]);
    expect(classes(container)).toEqual(["trace-casing", "trace"]);
    surface.clear();
    expect(container.querySelectorAll("path").length).toBe(0);
    surface.destroy();
    // The map is gone: no panes, no controls, no tiles left in the element.
    expect(container.querySelector(".leaflet-pane, .leaflet-control, img.leaflet-tile")).toBeNull();
  });

  it("frames a route that arrived while the map was hidden as soon as it is shown", () => {
    const container = sized(0, 0) as HTMLElement & { resizeTo(width: number, height: number): void };
    const surface = createLeafletSurface(container);
    surface.show(LINES);
    // Without a size there is nothing to frame yet: no view, no tiles, no lines.
    expect(container.querySelectorAll("img.leaflet-tile").length).toBe(0);
    expect(classes(container)).toEqual([]);
    surface.resize();
    expect(container.querySelectorAll("img.leaflet-tile").length).toBe(0);
    container.resizeTo(600, 400);
    surface.resize();
    expect(classes(container)).toEqual(["trace-casing", "trace trace-inferred", "trace-casing", "trace"]);
    const tiles = [...container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")];
    expect(tiles.length).toBeGreaterThan(0);
    expect(Number(tiles[0]?.src.split("/")[3])).toBeGreaterThanOrEqual(12);
    // Showing the tab again later does not move a map the user may have panned.
    const before = tiles.map((tile) => tile.src).join();
    surface.resize();
    expect([...container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")].map((tile) => tile.src).join()).toBe(before);
    // Not even when the map has become much smaller: the route was framed once, the rest is up to the user.
    const zoomBefore = tiles[0]?.src.split("/")[3];
    container.resizeTo(120, 80);
    surface.resize();
    const zooms = new Set([...container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")].map((tile) => tile.src.split("/")[3]));
    expect([...zooms]).toEqual([zoomBefore]);
    surface.destroy();
  });

  it("waits for a height as well as a width", () => {
    const container = sized(600, 0) as HTMLElement & { resizeTo(width: number, height: number): void };
    const surface = createLeafletSurface(container);
    surface.show(LINES);
    expect(container.querySelectorAll("img.leaflet-tile").length).toBe(0);
    container.resizeTo(600, 400);
    surface.resize();
    expect(container.querySelectorAll("img.leaflet-tile").length).toBeGreaterThan(0);
    surface.destroy();
  });

  it("does not zoom in past street level on a very short stretch", () => {
    const container = sized(600, 400);
    const surface = createLeafletSurface(container);
    // Fifty metres: framed alone it would ask for the deepest zoom there is.
    surface.show([{ inferred: false, points: [[40.3, -1.1], [40.30045, -1.1]] }]);
    const zooms = [...container.querySelectorAll<HTMLImageElement>("img.leaflet-tile")].map((tile) => tile.src.split("/")[3]);
    expect(new Set(zooms)).toEqual(new Set(["16"]));
    surface.destroy();
  });

  it("forgets a hidden route that was cleared before the map was shown", () => {
    const container = sized(0, 0) as HTMLElement & { resizeTo(width: number, height: number): void };
    const surface = createLeafletSurface(container);
    surface.show(LINES);
    surface.clear();
    container.resizeTo(600, 400);
    surface.resize();
    expect(container.querySelectorAll("img.leaflet-tile").length).toBe(0);
    surface.destroy();
  });
});

describe("tile layer under the content security policy", () => {
  interface FakeLayer {
    _tiles: Record<string, { el: HTMLImageElement; coords: { z: number } }>;
    _tileZoom: number;
    _map: object | null;
    fire: (type: string) => void;
  }
  const methods = PolicyFriendlyTiles.prototype as unknown as {
    _abortLoading(this: FakeLayer): void;
    _removeTile(this: FakeLayer, key: string): void;
    _tileReady(this: FakeLayer, coords: unknown, error: unknown, tile: HTMLElement | undefined): void;
  };
  function tile(src: string, complete: boolean): HTMLImageElement {
    const image = document.createElement("img");
    image.setAttribute("src", src);
    Object.defineProperty(image, "complete", { value: complete });
    document.body.append(image);
    return image;
  }
  const URL_A = "https://tile.openstreetmap.org/5/1/1.png";

  it("cancels a tile of another zoom that is still loading by dropping its address, never with a data: image", () => {
    const loading = tile(URL_A, false);
    const done = tile(URL_A, true);
    const current = tile(URL_A, false);
    const fired: string[] = [];
    const layer: FakeLayer = {
      _tiles: { a: { el: loading, coords: { z: 5 } }, b: { el: done, coords: { z: 5 } }, c: { el: current, coords: { z: 9 } } },
      _tileZoom: 9,
      _map: {},
      fire: (type) => void fired.push(type),
    };
    methods._abortLoading.call(layer);
    expect(loading.hasAttribute("src")).toBe(false);
    expect(loading.isConnected).toBe(false);
    expect(Object.keys(layer._tiles)).toEqual(["b", "c"]);
    expect(fired).toEqual(["tileabort"]);
    // A finished tile and a tile of the current zoom are left alone.
    expect(done.getAttribute("src")).toBe(URL_A);
    expect(current.getAttribute("src")).toBe(URL_A);
    expect(current.isConnected).toBe(true);
    for (const image of [loading, done, current]) expect(image.getAttribute("src") ?? "").not.toContain("data:");
  });

  it("drops the address of a removed tile, never replacing it with a data: image", () => {
    const image = tile(URL_A, false);
    const layer: FakeLayer = { _tiles: { a: { el: image, coords: { z: 5 } } }, _tileZoom: 5, _map: {}, fire: () => undefined };
    // Leaflet's own removal runs after ours and needs a real layer: here it may fail, after the address is gone.
    try {
      methods._removeTile.call(layer, "a");
    } catch {
      // Not what this test is about.
    }
    expect(image.hasAttribute("src")).toBe(false);
    expect(() => methods._removeTile.call(layer, "missing")).not.toThrow();
  });

  it("ignores a tile whose address was dropped, and everything once the layer is off the map", () => {
    const dropped = document.createElement("img");
    const layer: FakeLayer = { _tiles: {}, _tileZoom: 5, _map: {}, fire: () => undefined };
    // Neither call may reach Leaflet's own handler, which would fail on this fake layer.
    expect(() => methods._tileReady.call(layer, {}, null, dropped)).not.toThrow();
    expect(() => methods._tileReady.call({ ...layer, _map: null }, {}, null, tile(URL_A, true))).not.toThrow();
    expect(() => methods._tileReady.call(layer, {}, null, tile(URL_A, true))).toThrow();
  });
});

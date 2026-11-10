/**
 * The Leaflet map: OpenStreetMap tiles and the trimmed lines of one route.
 * It draws lines only. No markers, so the start and the end of a ride are
 * never pointed at.
 *
 * Tiles are the only third-party request of the whole web; the Content
 * Security Policy allows images from `tile.openstreetmap.org` and nothing
 * else (csp.config.json).
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng, TraceLine } from "../domain/model";
import { el } from "./dom";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** What the map of «Rutas» needs from a map; tests replace it with a recorder. */
export interface MapSurface {
  /** Draws these lines, replacing the previous ones, and frames them at once. */
  show(lines: readonly TraceLine[]): void;
  /**
   * Frames these lines without drawing them: a flight of `flyMs` when asked
   * and the map already has a view, a jump otherwise. `settled` runs once
   * the view is in place (at once for a jump), unless `clear` comes first.
   */
  frame(lines: readonly TraceLine[], flyMs: number | null, settled: () => void): void;
  /** Replaces the drawn lines by these, without moving the map, with a small head dot where the stroke is (none if null). */
  paint(lines: readonly TraceLine[], head: LatLng | null): void;
  /** Removes every line and the head, and stops a flight. */
  clear(): void;
  /** Call when the container changed size or became visible: lines that arrived while it was hidden are framed now. */
  resize(): void;
  /** Removes the map and its listeners. */
  destroy(): void;
}

export type SurfaceFactory = (container: HTMLElement) => MapSurface;

interface TileRecord {
  readonly el: HTMLImageElement;
  readonly coords: L.Coords;
}

/**
 * Leaflet cancels a tile that is still loading by pointing it at a tiny
 * "data:" image. The Content Security Policy does not allow "data:" images
 * (and should not, just for this), so the browser would log an error for
 * every cancelled tile. This layer cancels by dropping the address instead.
 * It replaces three private methods of Leaflet 1.9: check them when upgrading.
 */
export const PolicyFriendlyTiles = L.TileLayer.extend({
  _abortLoading(this: L.TileLayer & { _tiles: Record<string, TileRecord>; _tileZoom: number | undefined }) {
    for (const key of Object.keys(this._tiles)) {
      const record = this._tiles[key];
      if (record === undefined || record.coords.z === this._tileZoom) continue;
      const tile = record.el;
      tile.onload = null;
      tile.onerror = null;
      if (tile.complete) continue;
      tile.removeAttribute("src");
      tile.remove();
      Reflect.deleteProperty(this._tiles, key);
      this.fire("tileabort", { tile, coords: record.coords });
    }
  },
  _removeTile(this: L.TileLayer & { _tiles: Record<string, TileRecord> }, key: string) {
    const record = this._tiles[key];
    if (record === undefined) return;
    // Cancels a pending request, as Leaflet does, without the "data:" image.
    record.el.removeAttribute("src");
    (L.GridLayer.prototype as unknown as { _removeTile(key: string): void })._removeTile.call(this, key);
  },
  _tileReady(this: L.TileLayer & { _map: L.Map | null }, coords: L.Coords, error: unknown, tile: HTMLElement | undefined) {
    // A tile whose address was dropped above is no longer wanted.
    if (!this._map || (tile !== undefined && !tile.hasAttribute("src"))) return;
    (L.GridLayer.prototype as unknown as { _tileReady(coords: L.Coords, error: unknown, tile: HTMLElement | undefined): void })._tileReady.call(
      this,
      coords,
      error,
      tile,
    );
  },
}) as unknown as new (url: string, options: L.TileLayerOptions) => L.TileLayer;

/**
 * The attribution OpenStreetMap asks for, always visible. Built from DOM
 * nodes: Leaflet's own attribution control takes an HTML string, and this
 * repo does not hand HTML strings to anything.
 */
const Attribution = L.Control.extend({
  onAdd(): HTMLElement {
    return el(
      "div",
      { class: "leaflet-control-attribution" },
      "© colaboradores de ",
      el("a", { attrs: { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener noreferrer" } }, "OpenStreetMap"),
    );
  },
});

export const createLeafletSurface: SurfaceFactory = (container) => {
  // Zoom buttons at the bottom left: the top of the map stays clear.
  const map = L.map(container, { zoomControl: false, attributionControl: false });
  L.control.zoom({ position: "bottomleft", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  new Attribution({ position: "bottomright" }).addTo(map);
  new PolicyFriendlyTiles(TILE_URL, { maxZoom: 19 }).addTo(map);
  // No view is set until there is a route to frame: no tile is asked for before that.
  const drawn = L.layerGroup().addTo(map);
  /** One casing and one stroke per line, reused from frame to frame while a trace draws itself. */
  const casings: L.Polyline[] = [];
  const strokes: L.Polyline[] = [];
  let head: L.CircleMarker | null = null;
  /** Bounds still to be framed: set when lines arrive while the map has no size (it is off the page). */
  let toFrame: L.LatLngBounds | null = null;
  let hasView = false;
  /** The end of the flight under way, if any. */
  let flight: (() => void) | null = null;

  const boundsOf = (lines: readonly TraceLine[]): L.LatLngBounds => {
    const bounds = L.latLngBounds([]);
    for (const line of lines) for (const [latitude, longitude] of line.points) bounds.extend([latitude, longitude]);
    return bounds;
  };

  function jump(): void {
    // A map without size cannot be framed: it waits for `resize`. The size
    // is read from the element: Leaflet would remember a size of zero until
    // its first view is set.
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    map.invalidateSize();
    if (toFrame === null) return;
    map.fitBounds(toFrame, { padding: [32, 32], maxZoom: 16, animate: false });
    hasView = true;
    toFrame = null;
  }

  function stopFlight(): void {
    if (flight === null) return;
    map.off("moveend", flight);
    flight = null;
    map.stop();
  }

  function paint(lines: readonly TraceLine[], at: LatLng | null): void {
    for (const [index, line] of lines.entries()) {
      const points = line.points.map(([latitude, longitude]) => L.latLng(latitude, longitude));
      const className = line.inferred === true ? "trace trace-inferred" : "trace";
      const casing = casings[index];
      const stroke = strokes[index];
      if (casing !== undefined && stroke !== undefined && stroke.options.className === className) {
        casing.setLatLngs(points);
        stroke.setLatLngs(points);
        continue;
      }
      // A new line, or one of the other kind: drop this index and the ones after it.
      for (const extra of [...casings.splice(index), ...strokes.splice(index)]) extra.remove();
      // A dark casing under the line keeps it readable over any tile.
      casings.push(L.polyline(points, { className: "trace-casing", interactive: false }).addTo(drawn));
      strokes.push(L.polyline(points, { className, interactive: false }).addTo(drawn));
    }
    for (const extra of [...casings.splice(lines.length), ...strokes.splice(lines.length)]) extra.remove();
    if (at === null) {
      head?.remove();
      head = null;
    } else if (head === null) {
      head = L.circleMarker([at[0], at[1]], { className: "trace-head", radius: 5, interactive: false }).addTo(drawn);
    } else {
      head.setLatLng([at[0], at[1]]).bringToFront();
    }
  }

  function clear(): void {
    stopFlight();
    drawn.clearLayers();
    casings.length = 0;
    strokes.length = 0;
    head = null;
    toFrame = null;
  }

  return {
    show(lines) {
      clear();
      paint(lines, null);
      const bounds = boundsOf(lines);
      toFrame = bounds.isValid() ? bounds : null;
      jump();
    },
    frame(lines, flyMs, settled) {
      stopFlight();
      const bounds = boundsOf(lines);
      const sized = container.clientWidth > 0 && container.clientHeight > 0;
      if (!bounds.isValid() || flyMs === null || !hasView || !sized) {
        toFrame = bounds.isValid() ? bounds : null;
        jump();
        settled();
        return;
      }
      map.invalidateSize();
      const end = (): void => {
        if (flight !== end) return;
        map.off("moveend", end);
        flight = null;
        settled();
      };
      flight = end;
      map.on("moveend", end);
      map.flyToBounds(bounds, { padding: [32, 32], maxZoom: 16, duration: flyMs / 1000 });
    },
    paint,
    clear,
    resize() {
      jump();
    },
    destroy() {
      stopFlight();
      map.remove();
    },
  };
};

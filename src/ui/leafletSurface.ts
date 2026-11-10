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
import type { TraceLine } from "../domain/model";
import { el } from "./dom";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** What the Mapa tab needs from a map; tests replace it with a recorder. */
export interface MapSurface {
  /** Draws these lines, replacing the previous ones, and frames them. */
  show(lines: readonly TraceLine[]): void;
  /** Removes every line. */
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
  const map = L.map(container, { zoomControl: false, attributionControl: false });
  L.control.zoom({ zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  new Attribution({ position: "bottomright" }).addTo(map);
  new PolicyFriendlyTiles(TILE_URL, { maxZoom: 19 }).addTo(map);
  // No view is set until there is a route to frame: no tile is asked for before that.
  const drawn = L.layerGroup().addTo(map);
  /** Bounds still to be framed: set when lines arrive while the map has no size (its tab is hidden). */
  let toFrame: L.LatLngBounds | null = null;

  function frame(): void {
    // A map without size (its tab is hidden) cannot be framed: it waits for
    // `resize`. The size is read from the element: Leaflet would remember a
    // size of zero until its first view is set.
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    map.invalidateSize();
    if (toFrame === null) return;
    map.fitBounds(toFrame, { padding: [24, 24], maxZoom: 16, animate: false });
    toFrame = null;
  }

  return {
    show(lines) {
      drawn.clearLayers();
      const bounds = L.latLngBounds([]);
      for (const line of lines) {
        const points = line.points.map(([latitude, longitude]) => L.latLng(latitude, longitude));
        for (const point of points) bounds.extend(point);
        // A white casing under the line keeps it readable over any tile.
        L.polyline(points, { className: "trace-casing", interactive: false }).addTo(drawn);
        L.polyline(points, { className: line.inferred === true ? "trace trace-inferred" : "trace", interactive: false }).addTo(drawn);
      }
      toFrame = bounds.isValid() ? bounds : null;
      frame();
    },
    clear() {
      drawn.clearLayers();
      toFrame = null;
    },
    resize() {
      frame();
    },
    destroy() {
      map.remove();
    },
  };
};

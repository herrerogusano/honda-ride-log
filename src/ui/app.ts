/**
 * The page: landing, demo mode, the load with its visible states (loading,
 * empty, error) and the three tabs. It talks to the service only through a
 * `ToolCaller`, so the demo and the real client share every line below.
 */
import { createDemoCaller, DEMO_SCENARIOS, isDemoScenario, scenarioFromHash, type DemoScenario } from "../demo/scenarios";
import { formatNumber } from "../domain/format";
import type { VehicleState } from "../domain/model";
import type { ToolCaller } from "../service/contract";
import { loadAllRoutes, loadVehicleInfo, loadVehicleState, LoadError } from "../service/loader";
import type { StorageScope } from "../storage/maintenance";
import { buildRiderData, type RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { errorText } from "./errors";
import { createMapView, type MapFactory, type MapView } from "./mapView";
import { renderRoutes } from "./routesView";
import { renderSummary } from "./summary";
import { createTabs } from "./tabs";

export interface AppOptions {
  readonly root: HTMLElement;
  /** The clock; tests pin it. */
  readonly now?: () => number;
  /** Artificial wait of each demo answer, so loading states can be seen. */
  readonly demoDelayMs?: number;
  readonly createMap?: MapFactory;
}

export interface App {
  startDemo(scenario: DemoScenario): Promise<void>;
  /** Loads a rider through any caller. Phase 3 calls this after the login. */
  load(caller: ToolCaller, options: { readonly demo: boolean }): Promise<void>;
  showLanding(): void;
}

function setHash(hash: string): void {
  // Replaces the fragment without adding a history entry or reloading.
  history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
}

export function startApp(options: AppOptions): App {
  const { root } = options;
  const now = options.now ?? Date.now;
  const mapFactory = options.createMap ?? createMapView;
  /** Each load gets a number; a load that is no longer the latest stops drawing. */
  let generation = 0;
  /** The map of the view on screen; released when another view replaces it. */
  let activeMap: MapView | null = null;
  const releaseMap = (): void => {
    activeMap?.destroy();
    activeMap = null;
  };

  /** The demo scenario on screen, or null outside the demo. */
  let scenarioShown: DemoScenario | null = null;

  // The banner and its selector are built once and kept: rebuilding them on
  // every change would throw the keyboard focus away.
  const scenarioId = uniqueId("scenario");
  const scenarioSelect = el(
    "select",
    { id: scenarioId },
    ...DEMO_SCENARIOS.map((one) => el("option", { attrs: { value: one.id } }, one.label)),
  );
  scenarioSelect.addEventListener("change", () => {
    if (isDemoScenario(scenarioSelect.value)) void startDemo(scenarioSelect.value);
  });
  const banner = el(
    "div",
    { class: "demo-banner", attrs: { role: "note" } },
    el("p", {}, el("strong", {}, "Modo demo: datos de ejemplo. "), "Nada de lo que ves aquí viene de una moto ni de una cuenta real."),
    el(
      "div",
      { class: "demo-controls" },
      el("label", { attrs: { for: scenarioId } }, "Escenario"),
      scenarioSelect,
      el(
        "button",
        {
          class: "button button-quiet",
          attrs: { type: "button" },
          on: {
            click: () => {
              showLanding();
              // The button that was pressed is gone: leave the focus on the way back in.
              content.querySelector("button")?.focus();
            },
          },
        },
        "Salir de la demo",
      ),
    ),
  );
  banner.hidden = true;
  // Focusable by script only, to move the focus to what a button just replaced.
  const content = el("div", { class: "content", attrs: { tabindex: -1 } });
  clear(root);
  root.append(
    el("header", { class: "topbar" }, el("h1", { class: "brand" }, el("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }), "Ride Log")),
    banner,
    content,
  );

  function showLanding(): void {
    generation += 1;
    releaseMap();
    scenarioShown = null;
    banner.hidden = true;
    setHash("");
    clear(content);
    content.append(
      el(
        "section",
        { class: "landing" },
        el("h2", {}, "Tus rutas, en cifras"),
        el(
          "p",
          { class: "lead" },
          "Esta web enseña a cada persona invitada las estadísticas de sus propias rutas, a partir de su cuenta de MAPIT. Es un proyecto personal, sin relación con Honda ni con MAPIT.",
        ),
        el(
          "ul",
          { class: "promises" },
          el("li", {}, "Los datos se leen y se calculan en tu navegador; esta web no tiene servidor propio ni analítica."),
          el("li", {}, "Nunca se muestran la matrícula, el bastidor, el concesionario ni la posición actual de la moto."),
          el("li", {}, "Los mapas ocultan los primeros y los últimos 400 m de cada ruta."),
        ),
        el("p", {}, "El acceso con tu cuenta todavía no está disponible. Mientras tanto puedes ver cómo funciona con datos de ejemplo."),
        el(
          "button",
          {
            class: "button button-primary",
            attrs: { type: "button" },
            on: {
              click: () => {
                void startDemo("commuter");
                content.focus();
              },
            },
          },
          "Ver la demo",
        ),
      ),
    );
  }

  function errorPanel(error: LoadError, retry: () => void): HTMLElement {
    const text = errorText(error);
    return el(
      "div",
      { class: "error", attrs: { role: "alert" } },
      el("h2", {}, text.title),
      el("p", {}, text.explanation),
      el("p", {}, "Código: ", el("code", {}, text.code)),
      el(
        "button",
        {
          class: "button",
          attrs: { type: "button" },
          on: {
            click: () => {
              retry();
              content.focus();
            },
          },
        },
        "Reintentar",
      ),
    );
  }

  function vehicleLine(vehicle: VehicleState): HTMLElement {
    const parts = [
      vehicle.batteryPercent === null ? null : `Batería ${formatNumber(vehicle.batteryPercent)} %`,
      vehicle.odometer === null ? null : `Odómetro ${formatNumber(vehicle.odometer)} km`,
    ].filter((part): part is string => part !== null);
    return el("p", { class: "vehicle-line" }, parts.length > 0 ? parts.join(" · ") : "Estado de la moto recibido.");
  }

  function showLoaded(data: RiderData, caller: ToolCaller, warnings: readonly string[]): void {
    const scope: StorageScope = data.demo ? "demo" : "account";
    const map = mapFactory(data, caller);
    activeMap = map;
    const summaryPanel = el("div", {}, renderSummary(data, scope));
    const mapPanel = el("div", {}, map.element);
    const routesPanel = el("div", {});
    const tabs = createTabs(
      "Secciones",
      [
        { id: "resumen", label: "Resumen", panel: summaryPanel },
        { id: "mapa", label: "Mapa", panel: mapPanel },
        { id: "rutas", label: "Rutas", panel: routesPanel },
      ],
      (id) => {
        if (id === "mapa") map.shown();
      },
    );
    routesPanel.append(
      renderRoutes(data, (route) => {
        tabs.select("mapa", true);
        map.open(route);
      }),
    );
    clear(content);
    content.append(...warnings.map((warning) => el("p", { class: "notice", attrs: { role: "status" } }, warning)), tabs.element);
  }

  async function load(caller: ToolCaller, loadOptions: { readonly demo: boolean }): Promise<void> {
    generation += 1;
    releaseMap();
    const mine = generation;
    const current = (): boolean => mine === generation;
    const retry = (): void => void load(caller, loadOptions);
    if (!loadOptions.demo) {
      // A real account: nothing of the demo may stay on screen or in the address.
      scenarioShown = null;
      banner.hidden = true;
      if (scenarioFromHash(location.hash) !== null) setHash("");
    }
    const progress = el("p", { class: "loading", attrs: { role: "status" } }, "Leyendo el estado de la moto…");
    clear(content);
    content.append(progress);

    let vehicle: VehicleState;
    try {
      vehicle = await loadVehicleState(caller);
    } catch (error) {
      // The first call is the end-to-end check: if it fails, nothing else is asked.
      if (current() && error instanceof LoadError) {
        clear(content);
        content.append(errorPanel(error, retry));
        return;
      }
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    content.prepend(vehicleLine(vehicle));
    progress.textContent = "Leyendo los datos del vehículo…";

    const warnings: string[] = [];
    let info = null;
    try {
      info = await loadVehicleInfo(caller);
    } catch (error) {
      if (!(error instanceof LoadError)) throw error;
      // Model and mileage are extras: the page works without them and says so.
      warnings.push(`${errorText(error).title} El resto funciona. Código: ${errorText(error).code}`);
    }
    if (!current()) return;


    try {
      // A load that was replaced stops asking the service, not only drawing.
      const routes = await loadAllRoutes(
        caller,
        now(),
        (step) => {
          progress.textContent = `Cargando rutas de ${step.year}… ${formatNumber(step.loaded)} hasta ahora.`;
        },
        current,
      );
      if (!current()) return;
      showLoaded(buildRiderData(vehicle, info, routes, loadOptions.demo, now()), caller, warnings);
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof LoadError)) throw error;
      progress.remove();
      content.append(errorPanel(error, retry));
    }
  }

  async function startDemo(scenario: DemoScenario): Promise<void> {
    setHash(scenario === "commuter" ? "#demo" : `#demo=${scenario}`);
    scenarioShown = scenario;
    scenarioSelect.value = scenario;
    banner.hidden = false;
    await load(createDemoCaller(scenario, now(), options.demoDelayMs ?? 120), { demo: true });
  }

  // Typing or following `#demo=...` on an open page changes the scenario too.
  window.addEventListener("hashchange", () => {
    const wanted = scenarioFromHash(location.hash);
    if (wanted !== null && wanted !== scenarioShown) void startDemo(wanted);
  });

  const fromHash = scenarioFromHash(location.hash);
  if (fromHash === null) showLanding();
  else void startDemo(fromHash);

  return { startDemo, load, showLanding };
}

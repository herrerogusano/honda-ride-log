/**
 * The page: landing, demo mode, the load with its visible states (loading,
 * empty, error) and the three tabs. It talks to the service only through a
 * `ToolCaller`, so the demo and the real client share every line below.
 */
import { createDemoCaller, DEMO_SCENARIOS, isDemoScenario, scenarioFromHash, type DemoScenario } from "../demo/scenarios";
import { formatNumber } from "../domain/format";
import type { VehicleState } from "../domain/model";
import type { ToolCaller } from "../service/contract";
import { loadAllRoutes, loadVehicleInfo, loadVehicleState, LoadError, signInError } from "../service/loader";
import type { StorageScope } from "../storage/maintenance";
import { buildRiderData, type RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { errorText } from "./errors";
import { createMapView, type MapFactory, type MapView } from "./mapView";
import { renderRoutes } from "./routesView";
import { renderSummary } from "./summary";
import { createTabs } from "./tabs";

/**
 * The way in and out of a real account, given only when the build has a
 * service configured (`src/boot.ts`). Without it the page offers the demo
 * alone and shows no sign-in button.
 */
export interface AccountActions {
  /** Leaves for the login page. Rejects without leaving if it cannot start (for example, no sessionStorage). */
  signIn(): Promise<void>;
  /** Forgets the token and any half-done login; may leave for the login's sign-out page. */
  signOut(): void;
}

export interface AppOptions {
  readonly root: HTMLElement;
  /** The clock; tests pin it. */
  readonly now?: () => number;
  /** Artificial wait of each demo answer, so loading states can be seen. */
  readonly demoDelayMs?: number;
  readonly createMap?: MapFactory;
  readonly account?: AccountActions;
  /**
   * What to show first: the landing or the demo, as the address says
   * (`"address"`, the default), or nothing (`"none"`) because the caller is
   * about to show an account or a sign-in error and the address must not
   * start the demo.
   */
  readonly initialView?: "address" | "none";
}

export interface App {
  startDemo(scenario: DemoScenario): Promise<void>;
  /** Loads a rider through any caller. `src/boot.ts` calls it with `demo: false` after the login. */
  load(caller: ToolCaller, options: { readonly demo: boolean }): Promise<void>;
  /** The landing, with a failed sign-in above it if one is given. Abandons any load and drops its data. */
  showLanding(problem?: LoadError): void;
  /** Stops listening to the address and abandons any load in progress. The page keeps what it shows. */
  dispose(): void;
}

function setHash(hash: string): void {
  // Replaces the fragment without adding a history entry or reloading.
  history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
}

export function startApp(options: AppOptions): App {
  const { root, account } = options;
  const now = options.now ?? Date.now;
  const mapFactory = options.createMap ?? createMapView;
  /** Each load gets a number; a load that is no longer the latest stops drawing. */
  let generation = 0;
  /** The map of the view on screen; released when another view replaces it. */
  let activeMap: MapView | null = null;
  /** Motion of the view on screen (counts, reveals); aborted when another view replaces it. */
  let viewMotion: AbortController | null = null;
  const releaseMap = (): void => {
    activeMap?.destroy();
    activeMap = null;
    viewMotion?.abort();
    viewMotion = null;
  };

  /** The demo scenario on screen, or null outside the demo. */
  let scenarioShown: DemoScenario | null = null;
  /** True while the view on screen belongs to a real account. */
  let accountShown = false;

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
    el(
      "p",
      { class: "demo-text" },
      el("strong", { class: "demo-flag" }, "Modo demo: datos de ejemplo. "),
      "Nada de lo que ves aquí viene de una moto ni de una cuenta real.",
    ),
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

  /**
   * Goes to the login page; if it cannot start, says why on the landing.
   * An account still on screen (its session over) is cleared first, so a
   * page the browser restores with Back shows the landing, not its data.
   */
  const signIn = (): void => {
    if (accountShown) showLanding();
    account?.signIn().catch((error: unknown) => {
      showLanding(signInError(error));
      content.focus();
    });
  };
  const signInButton = (label: string, primary: boolean): HTMLElement =>
    el("button", { class: primary ? "button button-primary" : "button", attrs: { type: "button" }, on: { click: signIn } }, label);

  // Shown only while a real account is on screen (its data, its load or its error).
  const signOutButton = el(
    "button",
    {
      class: "button button-quiet sign-out",
      attrs: { type: "button" },
      on: {
        click: () => {
          // The landing first: the load stops asking and its data leaves the
          // page. Then the token is forgotten, so a request still waiting in
          // the client's queue never goes out.
          showLanding();
          account?.signOut();
          content.querySelector("button")?.focus();
        },
      },
    },
    "Salir",
  );
  signOutButton.hidden = true;
  clear(root);
  root.append(
    el(
      "header",
      { class: "topbar" },
      el(
        "div",
        { class: "topbar-in" },
        el("h1", { class: "brand" }, el("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }), el("b", {}, "Ride"), " Log"),
        signOutButton,
      ),
    ),
    banner,
    content,
  );

  function showLanding(problem?: LoadError): void {
    generation += 1;
    releaseMap();
    scenarioShown = null;
    accountShown = false;
    banner.hidden = true;
    signOutButton.hidden = true;
    setHash("");
    clear(content);
    if (problem !== undefined) content.append(errorPanel(problem, null));
    content.append(
      el(
        "section",
        { class: "landing" },
        el("p", { class: "eyebrow" }, "Ride Log · estadísticas de tus rutas"),
        el(
          "h2",
          { class: "hero-title" },
          el("span", { class: "ln" }, el("span", { class: "ln-in" }, "Tus rutas,")),
          " ",
          el("span", { class: "ln" }, el("span", { class: "ln-in red" }, "en cifras.")),
        ),
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
        account === undefined
          ? el("p", {}, "El acceso con tu cuenta todavía no está disponible. Mientras tanto puedes ver cómo funciona con datos de ejemplo.")
          : el(
              "p",
              {},
              "Entra con tu cuenta de MAPIT: el login es la página del servicio, no esta web, y esta web no ve tu contraseña. También puedes ver cómo funciona con datos de ejemplo.",
            ),
        el(
          "div",
          { class: "landing-actions" },
          account === undefined ? null : signInButton("Entrar", true),
          el(
            "button",
            {
              class: account === undefined ? "button button-primary" : "button",
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
      ),
    );
  }

  /**
   * A failure, with what can be done about it. `retry` is null on the
   * landing, which has its own buttons. A failure that needs a new sign-in
   * never offers to retry: the client has already forgotten the token.
   */
  function errorPanel(error: LoadError, retry: (() => void) | null): HTMLElement {
    const text = errorText(error);
    let action: HTMLElement | null = null;
    if (retry !== null && text.action === "retry") {
      action = el(
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
      );
    } else if (retry !== null && text.action === "sign_in" && account !== undefined) {
      action = signInButton("Volver a entrar", true);
    }
    return el(
      "div",
      { class: "error", attrs: { role: "alert" } },
      el("h2", {}, text.title),
      el("p", {}, text.explanation),
      el("p", {}, "Código: ", el("code", {}, text.code)),
      action,
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
    // A failed trace that needs a new sign-in offers it, never a retry.
    const map = mapFactory(data, caller, { signIn: account === undefined || data.demo ? null : signIn });
    activeMap = map;
    viewMotion = new AbortController();
    const summaryPanel = el("div", {}, renderSummary(data, scope, { signal: viewMotion.signal }));
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
      accountShown = true;
      banner.hidden = true;
      signOutButton.hidden = account === undefined;
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
    accountShown = false;
    scenarioSelect.value = scenario;
    banner.hidden = false;
    signOutButton.hidden = true;
    await load(createDemoCaller(scenario, now(), options.demoDelayMs ?? 120), { demo: true });
  }

  // Typing or following `#demo=...` on an open page changes the scenario too.
  const onHashChange = (): void => {
    const wanted = scenarioFromHash(location.hash);
    // A real account on screen is never replaced by the demo from the address bar.
    if (accountShown) {
      // Nor does the request stay in the address, where a reload would obey it.
      if (wanted !== null) setHash("");
      return;
    }
    if (wanted === null) {
      // The fragment was removed while the demo was on screen: leave the demo.
      if (scenarioShown !== null) showLanding();
      return;
    }
    if (wanted !== scenarioShown) void startDemo(wanted);
  };
  window.addEventListener("hashchange", onHashChange);

  if ((options.initialView ?? "address") === "address") {
    const fromHash = scenarioFromHash(location.hash);
    if (fromHash === null) showLanding();
    else void startDemo(fromHash);
  }

  return {
    startDemo,
    load,
    showLanding,
    dispose() {
      generation += 1;
      window.removeEventListener("hashchange", onHashChange);
      releaseMap();
    },
  };
}

/**
 * The page: landing, demo mode, the load with its visible states (loading,
 * empty, error) and the rider's page, one scrolling page of numbered
 * sections under a sticky top bar (docs/PLAN.md, section 12). It talks to
 * the service only through a `ToolCaller`, so the demo and the real client
 * share every line below.
 */
import { createDemoCaller, DEMO_SCENARIOS, isDemoScenario, scenarioFromHash, type DemoScenario } from "../demo/scenarios";
import { formatNumber, formatWholeKm, withUnit } from "../domain/format";
import type { VehicleState } from "../domain/model";
import type { ToolCaller } from "../service/contract";
import { loadAllRoutes, loadVehicleInfo, loadVehicleState, LoadError, signInError } from "../service/loader";
import type { StorageScope } from "../storage/maintenance";
import { createAtlasView, type AtlasView } from "./atlas/atlasView";
import { buildRiderData, type RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { errorText } from "./errors";
import { loadingStage, type LoadingStage } from "./loadingStage";
import { createMapView, type MapFactory, type MapView } from "./mapView";
import { sectionNav } from "./nav";
import { createRouteList } from "./routesView";
import { heroTitle, promises, renderRiderPage } from "./summary";
import { createTraceStore, type TraceStore } from "./traceStore";

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
  /** Called each time the demo starts (a visit counter, docs/PLAN.md section 17). Never given any data. */
  readonly onDemo?: () => void;
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
  /** The atlas of the view on screen and the trimmed traces it shares with the map; released with the view. */
  let activeAtlas: AtlasView | null = null;
  let activeTraces: TraceStore | null = null;
  /**
   * Motion and listeners of the view on screen (counts, reveals, the section
   * links, the scroll spy, the progress bar); aborted when another view
   * replaces it.
   */
  let viewMotion: AbortController | null = null;

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
      el("span", { class: "demo-more" }, "Nada de lo que ves aquí viene de una moto ni de una cuenta real."),
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
  // Always in the bar while the demo is on screen; the banner above scrolls away.
  const demoBadge = el("span", { class: "demo-badge" }, "Demo");
  demoBadge.hidden = true;
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

  // The bar holds the section links and the period of the rider's page; other views leave them empty.
  const navSlot = el("div", { class: "bar-nav" });
  const periodSlot = el("div", { class: "bar-period" });
  const topbar = el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "topbar-in" },
      el(
        "div",
        { class: "bar-brand" },
        el("h1", { class: "brand" }, el("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }), el("b", {}, "Ride"), el("span", { class: "brand-word" }, " Log")),
        demoBadge,
      ),
      navSlot,
      el("div", { class: "bar-end" }, periodSlot, signOutButton),
    ),
  );
  clear(root);
  root.append(topbar, banner, content);

  const barHeight = (): number => topbar.getBoundingClientRect().height;

  /** Stops what the view on screen runs: its map, its motion, its observers and listeners. */
  function stopView(): void {
    activeMap?.destroy();
    activeMap = null;
    activeAtlas?.destroy();
    activeAtlas = null;
    // The trimmed traces leave memory with the view (sign-out, another load).
    activeTraces?.dispose();
    activeTraces = null;
    viewMotion?.abort();
    viewMotion = null;
  }

  /** Stops the view on screen and takes its parts out of the bar. */
  function releaseView(): void {
    stopView();
    clear(navSlot);
    clear(periodSlot);
    topbar.querySelector(".nav-progress")?.remove();
    topbar.classList.remove("has-nav");
  }

  function showDemoMarks(shown: boolean): void {
    banner.hidden = !shown;
    demoBadge.hidden = !shown;
  }

  function showLanding(problem?: LoadError): void {
    generation += 1;
    releaseView();
    scenarioShown = null;
    accountShown = false;
    showDemoMarks(false);
    signOutButton.hidden = true;
    setHash("");
    clear(content);
    if (problem !== undefined) content.append(errorPanel(problem, null));
    const titleId = uniqueId("hero");
    content.append(
      el(
        "section",
        { class: "hero landing", attrs: { "aria-labelledby": titleId } },
        el(
          "div",
          { class: "hero-grid" },
          el(
            "div",
            { class: "hero-copy" },
            el("p", { class: "eyebrow hero-eyebrow" }, "Ride Log · estadísticas de tus rutas"),
            heroTitle(titleId, ["Tus rutas,", "en cifras."]),
            el(
              "p",
              { class: "lead" },
              "Esta web enseña a cada persona invitada las estadísticas de sus propias rutas, a partir de su cuenta de MAPIT. Es un proyecto personal, sin relación con Honda ni con MAPIT.",
            ),
            account === undefined
              ? el("p", { class: "hero-note" }, "El acceso con tu cuenta todavía no está disponible. Mientras tanto puedes ver cómo funciona con datos de ejemplo.")
              : el(
                  "p",
                  { class: "hero-note" },
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
          el(
            "aside",
            { class: "plate promises-plate", attrs: { "aria-label": "Lo que esta web promete" } },
            el("p", { class: "eyebrow plate-head" }, "Lo que esta web promete"),
            el("ul", { class: "promises" }, ...promises().map((promise) => el("li", {}, promise))),
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
      el("p", { class: "error-code" }, "Código: ", el("code", {}, text.code)),
      action,
    );
  }

  function vehicleLine(vehicle: VehicleState): HTMLElement {
    const parts = [
      vehicle.batteryPercent === null ? null : `Batería ${withUnit(formatNumber(vehicle.batteryPercent), "%")}`,
      vehicle.odometer === null ? null : `Odómetro ${formatWholeKm(vehicle.odometer)}`,
    ].filter((part): part is string => part !== null);
    return el("p", { class: "vehicle-line" }, parts.length > 0 ? parts.join(" · ") : "Estado de la moto recibido.");
  }


  function showLoaded(data: RiderData, caller: ToolCaller, warnings: readonly string[], stage: LoadingStage): void {
    const scope: StorageScope = data.demo ? "demo" : "account";
    const motion = new AbortController();
    // A failed trace that needs a new sign-in offers it, never a retry.
    const mapBox = el("div", { class: "archive-map" });
    // On phones the map is pinned under the bar: a row brought into view must clear both.
    const visibleTop = (): number => Math.max(barHeight(), mapBox.getBoundingClientRect().bottom);
    /** Set when the list itself opened the route: its row is already where the user is looking. */
    let fromList = false;
    const list = createRouteList(
      data,
      (route) => {
        // The route opens in place, next to the list or above it: the page does not move.
        fromList = true;
        map.open(route);
        fromList = false;
      },
      { visibleTop },
    );
    // One read per route detail, shared by the map and the atlas.
    const traces = createTraceStore(caller);
    const signInOffer = account === undefined || data.demo ? null : signIn;
    const map = mapFactory(data, caller, {
      signIn: signInOffer,
      traces,
      // The map's own «anterior / siguiente» keep the list's chosen row in view.
      onOpen: (route) => list.mark(route, !fromList),
    });
    mapBox.append(map.element);
    activeMap = map;
    activeTraces = traces;
    const atlas = createAtlasView(data, "all", {
      traces,
      signIn: signInOffer,
      showOnMap: (route) => {
        // The route opens in the map of «Rutas» (its row marked) and the page goes there.
        map.open(route);
        nav.go("rutas");
      },
    });
    activeAtlas = atlas;
    viewMotion = motion;
    // Map and list together (side by side on wide screens, the map pinned above the list on narrow ones).
    const archive = el(
      "div",
      { class: "archive-wrap" },
      el("div", { class: "archive" }, mapBox, el("div", { class: "archive-list" }, list.element)),
      el("div", { class: "archive-notes" }, map.legend, list.note),
    );
    // The bar's height, for what sticks under it (the map); it changes when the bar wraps.
    const publishBar = (): void => document.documentElement.style.setProperty("--bar-h", `${Math.round(barHeight())}px`);
    if (typeof ResizeObserver === "function") {
      const watcher = new ResizeObserver(publishBar);
      watcher.observe(topbar);
      motion.signal.addEventListener("abort", () => watcher.disconnect(), { once: true });
    }
    const page = renderRiderPage(data, scope, { signal: motion.signal, archive, atlas });
    const nav = sectionNav(page.sections, { signal: motion.signal, offset: barHeight });
    navSlot.append(nav.element);
    topbar.prepend(nav.progress);
    topbar.classList.add("has-nav");
    if (page.period !== null) periodSlot.append(page.period);
    clear(content);
    content.append(
      ...warnings.map((warning) => el("p", { class: "notice", attrs: { role: "status" } }, warning)),
      page.hero,
      ...page.sections.map((section) => section.element),
      page.footer,
    );
    // The loading stage becomes the page: its wedge wipes over the hero and settles on the hero's wedge.
    stage.handOff(page.hero, motion.signal);
    publishBar();
  }

  async function load(caller: ToolCaller, loadOptions: { readonly demo: boolean }): Promise<void> {
    generation += 1;
    releaseView();
    const mine = generation;
    const current = (): boolean => mine === generation;
    const retry = (): void => void load(caller, loadOptions);
    if (!loadOptions.demo) {
      // A real account: nothing of the demo may stay on screen or in the address.
      scenarioShown = null;
      accountShown = true;
      showDemoMarks(false);
      signOutButton.hidden = account === undefined;
      if (scenarioFromHash(location.hash) !== null) setHash("");
    }
    // The instrument-cluster boot: its loops stop when this load is replaced, abandoned or done.
    const loading = new AbortController();
    viewMotion = loading;
    const stage = loadingStage({ signal: loading.signal });
    clear(content);
    content.append(stage.element);
    /** The stage resolves into an error panel: no wipe. */
    const fail = (...parts: HTMLElement[]): void => {
      loading.abort();
      clear(content);
      content.append(...parts);
    };

    let vehicle: VehicleState;
    try {
      vehicle = await loadVehicleState(caller);
    } catch (error) {
      // The first call is the end-to-end check: if it fails, nothing else is asked.
      if (current() && error instanceof LoadError) {
        fail(errorPanel(error, retry));
        return;
      }
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    const line = vehicleLine(vehicle);
    stage.showVehicle(line);
    stage.step("Vehículo", "Leyendo los datos del vehículo…");

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
        (step) => stage.progress(step.year, step.loaded),
        current,
      );
      if (!current()) return;
      // A fast load still reads as a boot: at most a short hold, never more than MAX_HOLD_MS.
      await stage.settle();
      if (!current()) return;
      loading.abort();
      showLoaded(buildRiderData(vehicle, info, routes, loadOptions.demo, now()), caller, warnings, stage);
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof LoadError)) throw error;
      // The stage goes; what is known of the vehicle stays above the error.
      fail(line, errorPanel(error, retry));
    }
  }

  async function startDemo(scenario: DemoScenario): Promise<void> {
    setHash(scenario === "commuter" ? "#demo" : `#demo=${scenario}`);
    scenarioShown = scenario;
    accountShown = false;
    scenarioSelect.value = scenario;
    showDemoMarks(true);
    signOutButton.hidden = true;
    options.onDemo?.();
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
      stopView();
    },
  };
}

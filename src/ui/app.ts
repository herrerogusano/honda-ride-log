/**
 * The page: landing, demo mode, the load with its visible states (loading,
 * empty, error) and the rider's page, one scrolling page of numbered
 * sections under a sticky top bar (docs/PLAN.md, section 12). It talks to
 * the service only through a `ToolCaller`, so the demo and the real client
 * share every line below.
 */
import { createDemoCaller, DEMO_SCENARIOS, isDemoScenario, scenarioFromHash, type DemoScenario } from "../demo/scenarios";
import { formatNumber, formatWholeKm, withUnit } from "../domain/format";
import type { AccountData, VehicleInfo, VehicleOption, VehicleState } from "../domain/model";
import type { Period } from "../domain/stats";
import type { ToolArguments, ToolCaller, ToolName } from "../service/contract";
import {
  isVehicleChoiceError,
  loadAllRoutes,
  loadVehicleInfo,
  loadVehicles,
  loadVehicleState,
  LoadError,
  signInError,
} from "../service/loader";
import {
  defaultVehicle,
  memoryChoiceStore,
  selectorOrder,
  vehicleCaller,
  vehicleKey,
  vehicleMemory,
  type VehicleMemory,
} from "../service/vehicles";
import { adoptLegacyMaintenance, type MaintenanceSlot, type StorageScope } from "../storage/maintenance";
import { createAtlasView, type AtlasView } from "./atlas/atlasView";
import { buildRiderData, type RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { errorText } from "./errors";
import { loadingStage, type LoadingStage } from "./loadingStage";
import { createMapView, type MapFactory, type MapView } from "./mapView";
import { scrollToTop, sectionNav, type SectionNav } from "./nav";
import { createRouteList } from "./routesView";
import { heroTitle, promises, renderRiderPage, type RiderPage } from "./summary";
import { createTraceStore, type TraceStore } from "./traceStore";
import { vehiclePicker } from "./vehiclePicker";

/**
 * The way in and out of a real account, given only when the build has a
 * service configured (`src/boot.ts`). Without it the page offers the demo
 * alone and shows no sign-in button.
 */
export interface AccountActions {
  /** Leaves for the login page. Rejects without leaving if it cannot start (for example, no sessionStorage). */
  signIn(): Promise<void>;
  /**
   * Forgets the token and any half-done login; may leave for the login's
   * sign-out page. The open service first ends the session on the service
   * (asynchronously) and then leaves.
   */
  signOut(): Promise<void> | null | undefined;
  /** The open service only (docs/PLAN.md, section 18). Without it, the page is the invitation one. */
  readonly publicService?: PublicServiceActions;
}

export interface PublicServiceActions {
  /**
   * The screen before the login (status, consent, check, pass), drawn in
   * `host`. "Entrar" shows it instead of leaving at once. Returns a function
   * that takes it down.
   */
  showAccess(view: { readonly host: HTMLElement; back(): void; fail(error: unknown): void }): () => void;
  /** `borrar_mis_datos`, then sign out (the login's sign-out page, whatever the answer). */
  deleteMyData(): Promise<void>;
}

export interface AppOptions {
  readonly root: HTMLElement;
  /** The clock; tests pin it. */
  readonly now?: () => number;
  /** Artificial wait of each demo answer, so loading states can be seen. */
  readonly demoDelayMs?: number;
  readonly createMap?: MapFactory;
  /** Makes the store of whole traces each view shares between the map and the atlas; tests wrap it to look inside. */
  readonly createTraces?: (caller: ToolCaller) => TraceStore;
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

export interface LoadOptions {
  readonly demo: boolean;
  /**
   * An account's data kept in the tab, already checked by `restoreAccount`
   * (docs/PLAN.md, section 10, «Los datos de la cuenta»): painted at once,
   * without asking the service for the vehicle or the route list. Traces are
   * still asked for when a route is opened.
   */
  readonly saved?: AccountData | null;
  /** Called with what a load from the service brought, once it is on screen (to keep it in the tab). */
  readonly onLoaded?: (data: AccountData) => void;
  /**
   * Where the motorbike chosen in this tab is kept (docs/PLAN.md, section
   * 19): next to the session for a real account (src/boot.ts); in a
   * variable when left out.
   */
  readonly vehicles?: VehicleMemory;
}

/**
 * What one load knows of the account's motorbikes. `list` left out: not read
 * yet (the load asks `list_vehicles` first); null: the service has no such
 * tool and the page works without vehicle selection. `picked`: the
 * motorbike chosen in the selector, whose state is read again; `period`:
 * the period of the page it replaces.
 */
interface VehicleContext {
  readonly list?: readonly VehicleOption[] | null;
  readonly picked?: VehicleOption;
  readonly period?: Period;
}

/** The parts of a drawn page the load still talks to. */
type ShownPage = Pick<RiderPage, "showVehicle" | "setPicker" | "currentPeriod">;

/**
 * A caller whose real target is known later: a page painted from the tab
 * before the list of motorbikes says which one it is. Every call waits for
 * the target (and fails as it does).
 */
function deferredCaller(target: () => Promise<ToolCaller>): ToolCaller {
  return {
    async callTool<N extends ToolName>(name: N, args: ToolArguments[N]): Promise<unknown> {
      return (await target()).callTool(name, args);
    },
  };
}

export interface App {
  startDemo(scenario: DemoScenario): Promise<void>;
  /** Loads a rider through any caller. `src/boot.ts` calls it with `demo: false` after the login. */
  load(caller: ToolCaller, options: LoadOptions): Promise<void>;
  /** The landing, with a failed sign-in above it if one is given. Abandons any load and drops its data. */
  showLanding(problem?: LoadError): void;
  /** A fixed line above the landing (for example, a delete that was not confirmed). */
  showNotice(text: string): void;
  /** The open service's screen before the login, as «Entrar» shows it; the landing in any other build. */
  showAccess(): void;
  /**
   * The session ended (the token expired, or the service no longer takes
   * it): the whole traces kept in memory go (docs/PLAN.md, section 4). What
   * is on screen stays, with its «Volver a entrar».
   */
  forgetTraces(): void;
  /** Stops listening to the address and abandons any load in progress. The page keeps what it shows. */
  dispose(): void;
}

function setHash(hash: string): void {
  // Replaces the fragment without adding a history entry or reloading.
  history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
}


export function startApp(options: AppOptions): App {
  const { root, account } = options;
  const publicService = account?.publicService ?? null;
  const now = options.now ?? Date.now;
  /** Takes down the screen before the login of the open service, if it is on screen. */
  let closeAccess: (() => void) | null = null;
  const mapFactory = options.createMap ?? createMapView;
  const traceFactory = options.createTraces ?? createTraceStore;
  /** Each load gets a number; a load that is no longer the latest stops drawing. */
  let generation = 0;
  /** The map of the view on screen; released when another view replaces it. */
  let activeMap: MapView | null = null;
  /** The atlas of the view on screen and the traces it shares with the map; released with the view. */
  let activeAtlas: AtlasView | null = null;
  let activeTraces: TraceStore | null = null;
  /** The section links of the view on screen, if it has them; the brand asks them to go to the top. */
  let activeNav: SectionNav | null = null;
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
    if (publicService !== null) {
      showAccess(publicService);
      return;
    }
    if (accountShown) showLanding();
    account?.signIn().catch((error: unknown) => {
      showLanding(signInError(error));
      content.focus();
    });
  };

  /** The open service: the screen before the login, in place of the landing. */
  function showAccess(actions: PublicServiceActions): void {
    showLanding();
    clear(content);
    closeAccess = actions.showAccess({
      host: content,
      back: () => {
        showLanding();
        content.querySelector("button")?.focus();
      },
      fail: (error) => {
        showLanding(signInError(error));
        content.focus();
      },
    });
    content.focus();
  }

  /** A line above the landing, after leaving an account: what happened on the service. */
  function landingNotice(text: string, role: "status" | "alert"): void {
    content.querySelector(".account-notice")?.remove();
    content.prepend(el("p", { class: "notice account-notice", attrs: { role } }, text));
  }

  /** Leaves the account: the landing first, then the token goes (and, in the open service, the session on the service). */
  function leaveAccount(run: () => Promise<void> | null | undefined, pending: string): void {
    // The load stops asking and its data leaves the page before anything is sent.
    showLanding();
    const mine = generation;
    const outcome = run();
    content.querySelector("button")?.focus();
    if (outcome === null || outcome === undefined) return;
    landingNotice(pending, "status");
    // Normally the page has left for the login's sign-out page by now.
    void outcome.then(() => {
      if (mine === generation) content.querySelector(".account-notice")?.remove();
    });
  }
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
          if (account !== undefined) leaveAccount(() => account.signOut(), "Cerrando la sesión en el servicio…");
        },
      },
    },
    "Salir",
  );
  signOutButton.hidden = true;

  // The open service only, with a real account on screen: at the end of the
  // footer's «Privacidad», with a confirmation first.
  const deleteButton = el(
    "button",
    { class: "link-button delete-data", attrs: { type: "button" }, on: { click: () => confirmDelete() } },
    "Borrar mis datos",
  );
  const deleteLine = el("p", { class: "foot-delete" }, "Puedes borrar al momento tus datos de este servicio: ", deleteButton, ".");

  function confirmDelete(): void {
    if (publicService === null) return;
    content.querySelector(".delete-confirm")?.remove();
    const titleId = uniqueId("delete");
    const panel = el(
      "div",
      { class: "error delete-confirm", attrs: { role: "alertdialog", "aria-labelledby": titleId } },
      el("h2", { id: titleId }, "¿Borrar tus datos de este servicio?"),
      el(
        "p",
        {},
        "Se borran al momento tu sesión de MAPIT guardada, tu usuario de este servicio y el registro de tus entradas (la huella de tu correo, las fechas y el número de entradas). Tus datos en MAPIT no se modifican. El recuento de intentos fallidos caduca a las 24 horas y se borra en los días siguientes. Después se cierra la sesión.",
      ),
      el(
        "div",
        { class: "landing-actions" },
        el(
          "button",
          {
            class: "button button-primary",
            attrs: { type: "button" },
            on: { click: () => leaveAccount(() => publicService.deleteMyData(), "Borrando tus datos en el servicio…") },
          },
          "Borrar mis datos",
        ),
        el(
          "button",
          {
            class: "button",
            attrs: { type: "button" },
            on: {
              click: () => {
                panel.remove();
                deleteButton.focus();
              },
            },
          },
          "Cancelar",
        ),
      ),
    );
    // Right under the button, so the page does not jump away from it.
    deleteLine.after(panel);
    panel.scrollIntoView?.({ block: "nearest" });
    panel.querySelector("button")?.focus();
  }

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
        el(
          "h1",
          { class: "brand" },
          // A button, not a link: the address fragment is reserved for `#demo` (decision D-028).
          el(
            "button",
            {
              class: "brand-top",
              attrs: { type: "button", "aria-label": "Ride Log, ir arriba" },
              on: { click: goTop },
            },
            el("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }),
            el("b", {}, "Ride"),
            el("span", { class: "brand-word" }, " Log"),
          ),
        ),
        demoBadge,
      ),
      navSlot,
      el(
        "div",
        { class: "bar-end" },
        periodSlot,
        // The only account action in the bar; «Borrar mis datos» is in the footer.
        signOutButton,
      ),
    ),
  );
  clear(root);
  root.append(topbar, banner, content);

  const barHeight = (): number => topbar.getBoundingClientRect().height;

  /** The brand in the bar: back to the very top of the page, with the focus at its start. */
  function goTop(): void {
    if (activeNav !== null) activeNav.top(content);
    else scrollToTop(content);
  }

  /** Stops what the view on screen runs: its map, its motion, its observers and listeners. */
  function stopView(): void {
    closeAccess?.();
    closeAccess = null;
    activeMap?.destroy();
    activeMap = null;
    activeAtlas?.destroy();
    activeAtlas = null;
    // The traces leave memory with the view (sign-out, another load).
    activeTraces?.dispose();
    activeTraces = null;
    viewMotion?.abort();
    viewMotion = null;
  }

  /** Stops the view on screen and takes its parts out of the bar. */
  function releaseView(): void {
    stopView();
    activeNav = null;
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
              publicService === null
                ? "Esta web enseña a cada persona invitada las estadísticas de sus propias rutas, a partir de su cuenta de MAPIT. Es un proyecto personal, sin relación con Honda ni con MAPIT."
                : // The open service (docs/PLAN.md, section 18).
                  "Esta web enseña a quien tenga una cuenta de MAPIT las estadísticas de sus propias rutas. Es un proyecto personal, sin relación con Honda ni con MAPIT.",
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
    const text = errorText(error, publicService !== null);
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
    if (vehicle.cancelled === true) return el("p", { class: "vehicle-line" }, "Moto dada de baja: sin estado en vivo.");
    const parts = [
      vehicle.batteryPercent === null ? null : `Batería ${withUnit(formatNumber(vehicle.batteryPercent), "%")}`,
      vehicle.odometer === null ? null : `Odómetro ${formatWholeKm(vehicle.odometer)}`,
    ].filter((part): part is string => part !== null);
    return el("p", { class: "vehicle-line" }, parts.length > 0 ? parts.join(" · ") : "Estado de la moto recibido.");
  }


  /** The page on screen, to read its period when another motorbike replaces it. */
  let shownPage: ShownPage | null = null;

  /** How a page is drawn: where its maintenance numbers live, its selector and its opening period. */
  interface PageSetup {
    readonly vehicleKey: string | null;
    readonly picker: HTMLElement | null;
    readonly period?: Period | undefined;
  }

  /** Draws the page; gives back how to change its vehicle state and selector in place. */
  function showLoaded(data: RiderData, caller: ToolCaller, warnings: readonly string[], stage: LoadingStage, setup: PageSetup): ShownPage {
    const scope: StorageScope = data.demo ? "demo" : "account";
    const slot: MaintenanceSlot = { scope, vehicleKey: setup.vehicleKey };
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
      { visibleTop, signal: motion.signal },
    );
    // One read per route detail, shared by the map and the atlas.
    const traces = traceFactory(caller);
    const signInOffer = account === undefined || data.demo ? null : signIn;
    const map = mapFactory(data, caller, {
      signIn: signInOffer,
      publicService: publicService !== null,
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
      publicService: publicService !== null,
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
    // The pinned map's height, for the list's own box on narrow screens (it fits under both).
    const publishBar = (): void => {
      const root = document.documentElement.style;
      root.setProperty("--bar-h", `${Math.round(barHeight())}px`);
      root.setProperty("--map-h", `${Math.round(mapBox.getBoundingClientRect().height)}px`);
    };
    if (typeof ResizeObserver === "function") {
      const watcher = new ResizeObserver(publishBar);
      watcher.observe(topbar);
      watcher.observe(mapBox);
      motion.signal.addEventListener("abort", () => watcher.disconnect(), { once: true });
    }
    const page = renderRiderPage(data, slot, { signal: motion.signal, archive, atlas, picker: setup.picker, initialPeriod: setup.period });
    const nav = sectionNav(page.sections, { signal: motion.signal, offset: barHeight });
    activeNav = nav;
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
    // A real account in the open service can delete its data from the footer's «Privacidad».
    if (publicService !== null && accountShown) page.footer.querySelector(".foot-privacy")?.append(deleteLine);
    // The loading stage becomes the page: its wedge wipes over the hero and settles on the hero's wedge.
    stage.handOff(page.hero, motion.signal);
    publishBar();
    shownPage = page;
    return page;
  }

  /**
   * Reads the vehicle's state and details behind a page painted from the
   * tab, shows them in place and hands them on with the kept routes (to keep
   * the copy up to date). A failed read changes nothing and says nothing: the
   * kept state stays on screen. A sign-in problem still ends the session the
   * usual way (src/service/mcpClient.ts), and the next request says so.
   */
  async function refreshVehicle(
    caller: ToolCaller,
    saved: AccountData,
    showVehicle: RiderPage["showVehicle"],
    current: () => boolean,
    onLoaded: LoadOptions["onLoaded"],
    known: { readonly vehicle: VehicleState; readonly key: string | null } | null = null,
  ): Promise<void> {
    let vehicle: VehicleState;
    if (known !== null) {
      // `list_vehicles` already brought this motorbike's state.
      vehicle = known.vehicle;
    } else {
      try {
        vehicle = await loadVehicleState(caller);
      } catch (error) {
        if (error instanceof LoadError || !current()) return;
        throw error;
      }
    }
    if (!current()) return;
    let info = saved.info;
    try {
      info = await loadVehicleInfo(caller);
    } catch (error) {
      // Model and mileage are extras: the kept ones stay.
      if (!(error instanceof LoadError) && current()) throw error;
    }
    if (!current()) return;
    showVehicle(vehicle, info);
    const data: AccountData = { vehicle, info, routes: saved.routes, skipped: saved.skipped };
    onLoaded?.(known?.key ? { ...data, vehicleKey: known.key } : data);
  }

  /** The selector of the hero for an account with several motorbikes; null with one. */
  function pickerFor(base: ToolCaller, loadOptions: LoadOptions, list: readonly VehicleOption[], chosen: VehicleOption): HTMLElement | null {
    if (list.length < 2) return null;
    return vehiclePicker(selectorOrder(list), chosen, (picked) => {
      // One load per switch, with the loading sweep; the list is not asked again.
      const period = shownPage?.currentPeriod();
      void run(base, { ...loadOptions, saved: null }, { list, picked, ...(period === undefined ? {} : { period }) });
      content.focus();
    });
  }

  /**
   * The pair of maintenance numbers kept before vehicle selection belongs to
   * the first motorbike the service lists (src/storage/maintenance.ts).
   */
  async function adoptMaintenance(list: readonly VehicleOption[], demo: boolean): Promise<void> {
    const first = list.find((one) => one.order === 0);
    if (first !== undefined) adoptLegacyMaintenance(demo ? "demo" : "account", await vehicleKey(first.ref));
  }

  async function load(caller: ToolCaller, loadOptions: LoadOptions): Promise<void> {
    // One memory of the chosen motorbike for this account (or demo), shared by its retries and switches.
    const options = loadOptions.vehicles === undefined ? { ...loadOptions, vehicles: vehicleMemory(memoryChoiceStore()) } : loadOptions;
    await run(caller, options, {});
  }

  async function run(base: ToolCaller, loadOptions: LoadOptions, context: VehicleContext): Promise<void> {
    generation += 1;
    releaseView();
    shownPage = null;
    const mine = generation;
    const current = (): boolean => mine === generation;
    const memory = loadOptions.vehicles ?? vehicleMemory(memoryChoiceStore());
    // A retry always asks the service, the list of motorbikes included. A
    // choice the service refused is forgotten first.
    const retryFor = (error: LoadError) => (): void => {
      if (isVehicleChoiceError(error)) memory.forget();
      void run(base, { ...loadOptions, saved: null }, {});
    };
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

    const saved = loadOptions.demo || context.list !== undefined ? null : (loadOptions.saved ?? null);
    // Painted only under the motorbike it was loaded for (both null: a page without selection).
    const savedFits = saved !== null && (saved.vehicleKey ?? null) === (await memory.storedKey());
    if (!current()) return;
    if (saved !== null && savedFits) {
      // A reload of a signed-in tab: what the sign-in loaded, painted at once.
      loading.abort();
      const routes = { routes: saved.routes, skipped: saved.skipped, requests: 0 };
      // The list of motorbikes says which one this is, once: the refresh below
      // and any trace opened before it wait for the same answer.
      let listed: Promise<readonly VehicleOption[] | null> | null = null;
      const list = (): Promise<readonly VehicleOption[] | null> => {
        listed ??= loadVehicles(base).catch((error: unknown) => {
          listed = null;
          throw error;
        });
        return listed;
      };
      const chosenIn = (vehicles: readonly VehicleOption[]): VehicleOption | null =>
        // A copy kept before vehicle selection belongs to the only motorbike.
        memory.recall(vehicles) ?? ((saved.vehicleKey ?? null) === null && vehicles.length === 1 ? (vehicles[0] ?? null) : null);
      const pageCaller = deferredCaller(async () => {
        const vehicles = await list();
        const chosen = vehicles === null ? null : chosenIn(vehicles);
        return chosen === null ? base : vehicleCaller(base, chosen.ref);
      });
      const page = showLoaded(buildRiderData(saved.vehicle, saved.info, routes, false, now()), pageCaller, [], stage, {
        vehicleKey: saved.vehicleKey ?? null,
        picker: null,
      });
      // The vehicle changes between reloads (battery, last use): it is read
      // again behind the page, with the same two calls as a full load (the
      // list of motorbikes, which carries each one's state, and the details).
      // The route list is not.
      let vehicles: readonly VehicleOption[] | null;
      try {
        vehicles = await list();
      } catch (error) {
        if (error instanceof LoadError || !current()) return;
        throw error;
      }
      if (!current()) return;
      if (vehicles === null) {
        // A service without vehicle selection: as before.
        await refreshVehicle(base, saved, page.showVehicle, current, loadOptions.onLoaded);
        return;
      }
      const chosen = chosenIn(vehicles);
      const key = chosen === null ? null : await vehicleKey(chosen.ref);
      if (!current()) return;
      const fits = chosen !== null && (key === saved.vehicleKey || ((saved.vehicleKey ?? null) === null && vehicles.length === 1));
      if (chosen === null || !fits) {
        // The kept copy is not this motorbike's (or the choice is gone): load it whole.
        void run(base, { ...loadOptions, saved: null }, { list: vehicles });
        return;
      }
      memory.remember(chosen);
      await adoptMaintenance(vehicles, false);
      if (!current()) return;
      page.setPicker(pickerFor(base, loadOptions, vehicles, chosen));
      await refreshVehicle(vehicleCaller(base, chosen.ref), saved, page.showVehicle, current, loadOptions.onLoaded, { vehicle: chosen.state, key });
      return;
    }

    // The account's motorbikes first: one `list_vehicles`, which also brings each one's state.
    let list = context.list;
    if (list === undefined) {
      try {
        list = await loadVehicles(base);
      } catch (error) {
        // The first call is the end-to-end check: if it fails, nothing else is asked.
        if (current() && error instanceof LoadError) {
          fail(errorPanel(error, retryFor(error)));
          return;
        }
        if (current()) throw error;
        return;
      }
      if (!current()) return;
    }
    let chosen: VehicleOption | null = null;
    let caller = base;
    let listed: VehicleState | null = null;
    if (list !== null) {
      chosen = context.picked ?? memory.recall(list) ?? defaultVehicle(list);
      memory.remember(chosen);
      caller = vehicleCaller(base, chosen.ref);
      // A motorbike picked in the selector: its state is read now, not taken from an older list.
      if (context.picked === undefined) listed = chosen.state;
    }

    let vehicle: VehicleState;
    if (listed !== null) {
      vehicle = listed;
    } else {
      try {
        vehicle = await loadVehicleState(caller);
      } catch (error) {
        // Without vehicle selection this is the end-to-end check: if it fails, nothing else is asked.
        if (current() && error instanceof LoadError) {
          fail(errorPanel(error, retryFor(error)));
          return;
        }
        if (current()) throw error;
        return;
      }
    }
    if (!current()) return;
    // Local work (a hash and the move of old maintenance numbers), awaited before the page is drawn.
    const keyed = (async (): Promise<string | null> => {
      if (list !== null) await adoptMaintenance(list, loadOptions.demo);
      return chosen === null ? null : vehicleKey(chosen.ref);
    })();
    const line = vehicleLine(vehicle);
    stage.showVehicle(line);
    stage.step("Vehículo", "Leyendo los datos del vehículo…");

    const warnings: string[] = [];
    let info: VehicleInfo | null = null;
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
      const key = await keyed;
      if (!current()) return;
      loading.abort();
      showLoaded(buildRiderData(vehicle, info, routes, loadOptions.demo, now()), caller, warnings, stage, {
        vehicleKey: key,
        picker: list === null || chosen === null ? null : pickerFor(base, loadOptions, list, chosen),
        period: context.period,
      });
      const data: AccountData = { vehicle, info, routes: routes.routes, skipped: routes.skipped };
      if (!loadOptions.demo) loadOptions.onLoaded?.(key === null ? data : { ...data, vehicleKey: key });
    } catch (error) {
      if (!current()) return;
      if (!(error instanceof LoadError)) throw error;
      // The stage goes; what is known of the vehicle stays above the error.
      fail(line, errorPanel(error, retryFor(error)));
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
    showNotice(text) {
      showLanding();
      landingNotice(text, "alert");
    },
    showAccess() {
      if (publicService === null) showLanding();
      else showAccess(publicService);
    },
    forgetTraces() {
      activeTraces?.forget();
    },
    dispose() {
      generation += 1;
      window.removeEventListener("hashchange", onHashChange);
      stopView();
    },
  };
}

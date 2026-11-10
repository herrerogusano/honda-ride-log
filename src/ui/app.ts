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
import { buildRiderData, type RiderData } from "./data";
import { clear, el, uniqueId } from "./dom";
import { errorText } from "./errors";
import { createMapView, type MapFactory, type MapView } from "./mapView";
import { scrollBehavior } from "./motion";
import { sectionNav } from "./nav";
import { renderRoutes } from "./routesView";
import { heroTitle, PROMISES, renderRiderPage } from "./summary";

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

/** Room left between the sticky bar and what a button brings into view. */
const VIEW_GAP = 16;

export function startApp(options: AppOptions): App {
  const { root, account } = options;
  const now = options.now ?? Date.now;
  const mapFactory = options.createMap ?? createMapView;
  /** Each load gets a number; a load that is no longer the latest stops drawing. */
  let generation = 0;
  /** The map of the view on screen; released when another view replaces it. */
  let activeMap: MapView | null = null;
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
            el("ul", { class: "promises" }, ...PROMISES.map((promise) => el("li", {}, promise))),
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

  /**
   * The shape of the rider's page while it loads: the hero and the readout
   * as grey blocks, with the progress in a status line, so the page does not
   * jump when the data arrives. Only `copy` and `progress` carry text.
   */
  function skeleton(progress: HTMLElement): { element: HTMLElement; copy: HTMLElement } {
    const bone = (kind: string): HTMLElement => el("span", { class: `bone ${kind}` });
    const copy = el(
      "div",
      { class: "hero-copy" },
      el("div", { class: "bones", attrs: { "aria-hidden": "true" } }, bone("bone-eyebrow"), bone("bone-title"), bone("bone-title"), bone("bone-title short")),
      progress,
    );
    const element = el(
      "div",
      { class: "skeleton" },
      el(
        "div",
        { class: "hero hero-skeleton" },
        el("div", { class: "hero-grid" }, copy, el("div", { class: "plate bone bone-plate", attrs: { "aria-hidden": "true" } })),
      ),
      el(
        "div",
        { class: "bone-readout", attrs: { "aria-hidden": "true" } },
        ...Array.from({ length: 4 }, () => el("span", { class: "bone-cell" }, bone("bone-label"), bone("bone-figure"))),
      ),
    );
    return { element, copy };
  }

  /** Scrolls so that `target` starts just below the bar, unless it is already in view. */
  function bringIntoView(target: HTMLElement): void {
    const box = target.getBoundingClientRect();
    const top = barHeight();
    if (box.top >= top && box.top < window.innerHeight * 0.5) return;
    window.scrollTo({ top: Math.max(0, box.top + window.scrollY - top - VIEW_GAP), behavior: scrollBehavior() });
  }

  function showLoaded(data: RiderData, caller: ToolCaller, warnings: readonly string[]): void {
    const scope: StorageScope = data.demo ? "demo" : "account";
    const motion = new AbortController();
    // A failed trace that needs a new sign-in offers it, never a retry.
    const map = mapFactory(data, caller, { signIn: account === undefined || data.demo ? null : signIn });
    activeMap = map;
    viewMotion = motion;
    // Map first, list after; a later phase puts them side by side.
    const archive = el(
      "div",
      { class: "archive" },
      el("div", { class: "archive-map" }, map.element),
      el(
        "div",
        { class: "archive-list" },
        renderRoutes(data, (route) => {
          // The route opens in place: the map is in the same section, above the list.
          map.open(route);
          map.element.querySelector<HTMLElement>(".map-title")?.focus({ preventScroll: true });
          bringIntoView(map.element);
        }),
      ),
    );
    const page = renderRiderPage(data, scope, { signal: motion.signal, archive });
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
    const progress = el("p", { class: "loading", attrs: { role: "status" } }, "Leyendo el estado de la moto…");
    const shape = skeleton(progress);
    clear(content);
    content.append(shape.element);

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
    const line = vehicleLine(vehicle);
    shape.copy.prepend(line);
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
      // The shapes go; what is known of the vehicle stays above the error.
      clear(content);
      content.append(line, errorPanel(error, retry));
    }
  }

  async function startDemo(scenario: DemoScenario): Promise<void> {
    setHash(scenario === "commuter" ? "#demo" : `#demo=${scenario}`);
    scenarioShown = scenario;
    accountShown = false;
    scenarioSelect.value = scenario;
    showDemoMarks(true);
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
      stopView();
    },
  };
}

/**
 * The cookie notice (docs/PLAN.md, section 17). Shown only when the build
 * has Google Analytics: Cloudflare Web Analytics sets no cookie and needs
 * no consent.
 *
 * - Not a modal: the page stays usable behind it, nothing is loaded from
 *   Google until "Aceptar" is pressed, and ignoring it is the same as not
 *   accepting for this visit.
 * - "Aceptar" and "Rechazar" look the same and sit side by side.
 * - After answering, a "Cambiar las cookies" button at the end of the page reopens it,
 *   so the visitor can change their mind at any time.
 */
import { el, uniqueId } from "../ui/dom";
import type { Tracker } from "./tracker";

export interface ConsentNotice {
  /** Shows the notice again (the "Cambiar las cookies" button does this). */
  open(): void;
}

function explanation(tracker: Tracker): string {
  const google =
    "Google Analytics, que guarda cookies en este navegador y envía a Google la visita, si abres la demo y si entras con tu cuenta";
  const parts =
    tracker.config.cloudflareToken === null
      ? [`Si aceptas, esta web cuenta las visitas con ${google}.`]
      : ["Esta web cuenta las visitas con Cloudflare Web Analytics, que no usa cookies.", `Si aceptas, también con ${google}.`];
  parts.push("Si rechazas, Google Analytics no se carga. Tus rutas, tus cifras y los datos de tu moto nunca salen de tu navegador.");
  return parts.join(" ");
}

function stateText(tracker: Tracker): string {
  if (tracker.choice() === "granted") return "Google Analytics: aceptado.";
  if (tracker.choice() === "denied") return "Google Analytics: rechazado.";
  return "Google Analytics: sin responder; no se carga.";
}

export function mountConsentNotice(host: HTMLElement, tracker: Tracker): ConsentNotice {
  if (!tracker.needsConsent) {
    host.hidden = true;
    return { open: () => undefined };
  }

  const titleId = uniqueId("consent-title");
  const textId = uniqueId("consent-text");
  const state = el("span", { class: "consent-state" });
  const prefsButton = el("button", { class: "consent-link", attrs: { type: "button" } }, "Cambiar las cookies");
  const prefs = el("p", { class: "consent-prefs" }, state, " ", prefsButton);

  const accept = el("button", { class: "button consent-choice", attrs: { type: "button" } }, "Aceptar");
  const reject = el("button", { class: "button consent-choice", attrs: { type: "button" } }, "Rechazar");
  const notice = el(
    "section",
    { class: "consent", attrs: { "aria-labelledby": titleId, "aria-describedby": textId } },
    el("h2", { class: "consent-title", id: titleId }, "Cookies"),
    el("p", { class: "consent-text", id: textId }, explanation(tracker)),
    el("div", { class: "consent-actions" }, accept, reject),
  );

  function show(open: boolean): void {
    notice.hidden = !open;
    prefs.hidden = open;
    state.textContent = stateText(tracker);
  }

  function answer(granted: boolean): void {
    if (granted) tracker.grant();
    else tracker.deny();
    show(false);
    prefsButton.focus();
  }

  accept.addEventListener("click", () => answer(true));
  reject.addEventListener("click", () => answer(false));
  prefsButton.addEventListener("click", () => {
    show(true);
    accept.focus();
  });

  host.hidden = false;
  host.replaceChildren(notice, prefs);
  show(tracker.choice() === null);
  return {
    open() {
      show(true);
      accept.focus();
    },
  };
}

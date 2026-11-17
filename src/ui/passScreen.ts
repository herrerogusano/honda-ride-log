/**
 * The screen before the login of the open service (docs/PLAN.md, section
 * 18). It is shown instead of going straight to the login when a build has
 * `access: "public"`:
 *
 * 1. `GET /estado`: `abierto` or `lleno` show the form, `cerrado` and
 *    `pausa` say so and offer nothing to send.
 * 2. The form: the consent text (provisional), a checkbox, the email and the
 *    Turnstile check. "Continuar" sends `POST /pase`.
 * 3. With a pass, the login starts with the email as `login_hint`.
 *
 * The email lives in the field and in one request; it is never stored. A
 * Turnstile result is single use, so after any refusal the check starts over.
 * All texts are provisional.
 */
import { normalizeEmail, readStatus, requestPass, type AccessDeps, type AccessStatus, type PassOutcome } from "../access/publicAccess";
import type { ChallengeRenderer, ChallengeWidget } from "../access/turnstile";
import type { PublicAccessConfig } from "../service/environment";
import { clear, el, uniqueId } from "./dom";
import { MAINTENANCE_TEXT } from "./errors";

export interface PassScreenOptions {
  /** Where the screen goes; it is emptied first. */
  readonly host: HTMLElement;
  readonly access: PublicAccessConfig;
  readonly deps: AccessDeps;
  readonly renderChallenge: ChallengeRenderer;
  /** Leaves for the login with this email as hint. Rejects without leaving if it cannot start. */
  readonly startLogin: (email: string) => Promise<void>;
  /** "Volver": back to the landing. */
  readonly onBack: () => void;
  /** The login could not start (for example, no sessionStorage). */
  readonly onFailure: (error: unknown) => void;
}

/**
 * Provisional (docs/PLAN.md, section 18): the final text is still to be
 * written. Shown folded under the checkbox; the screen stays one short view.
 */
export const CONSENT_TEXT: readonly string[] = [
  "Texto provisional.",
  "Para enseñarte tus rutas, esta web te lleva al login del servicio, donde escribes la contraseña de tu cuenta de MAPIT. Esta web no la ve.",
  "El servicio guarda tu sesión de MAPIT cifrada durante menos de una hora y la borra al salir. Para limitar el acceso guarda también una huella de tu correo (no el correo), las fechas y el número de veces que entras, hasta un año después de tu última entrada. Puedes borrarlo cuando quieras con «Borrar mis datos».",
  "Tus datos en MAPIT no se modifican. Es un proyecto personal, sin relación con Honda ni con MAPIT.",
];

const STATUS_TEXT: Readonly<Record<Exclude<AccessStatus, "abierto">, string>> = {
  lleno: "No quedan plazas para personas nuevas. Si ya has entrado antes, puedes seguir entrando.",
  cerrado: "Ahora mismo no se admiten entradas. Vuelve a probar más adelante.",
  pausa: MAINTENANCE_TEXT,
  unavailable: "No se ha podido comprobar si se puede entrar. Revisa la conexión y prueba otra vez.",
};

const PASS_TEXT: Readonly<Record<Exclude<PassOutcome, "issued">, string>> = {
  bad_request: "El servicio no acepta este correo. Revísalo y vuelve a probar.",
  rejected: "La comprobación anti-robots no es válida o ya se ha usado. Hazla otra vez.",
  rate_limited: "Se han pedido demasiados accesos desde esta conexión. Espera unos minutos.",
  closed: STATUS_TEXT.cerrado,
  paused: MAINTENANCE_TEXT,
  unavailable: "El servicio no responde ahora mismo. Prueba de nuevo dentro de un rato.",
};

/** Shown while the (normally invisible) check has not finished; the pass goes out by itself when it does. */
const CHECKING = "Comprobando que no eres un robot…";

const CHALLENGE_FAILED = "No se ha podido hacer la comprobación anti-robots. Recarga la página o prueba con otro navegador.";

/** Shows the screen. The returned function takes it down (and the check with it). */
export function showPassScreen(options: PassScreenOptions): () => void {
  const { host, access, deps } = options;
  let disposed = false;
  let widget: ChallengeWidget | null = null;
  /** Each fresh start (first show, page restored from cache) gets a number; late answers of an older one draw nothing. */
  let round = 0;

  const titleId = uniqueId("pass");
  const body = el("div", { class: "pass-body" });
  const backButton = el("button", { class: "button", attrs: { type: "button" }, on: { click: () => options.onBack() } }, "Volver");
  clear(host);
  host.append(
    el(
      "section",
      { class: "hero pass-screen", attrs: { "aria-labelledby": titleId } },
      el("h2", { id: titleId, class: "pass-title" }, "Entrar"),
      body,
    ),
  );

  function dropWidget(): void {
    widget?.remove();
    widget = null;
  }

  function showStatus(): void {
    const mine = ++round;
    clear(body);
    body.append(el("p", { class: "loading", attrs: { role: "status" } }, "Comprobando si se puede entrar…"), el("div", { class: "landing-actions" }, backButton));
    void readStatus(access.statusUrl, deps).then((status) => {
      if (disposed || mine !== round) return;
      if (status === "abierto" || status === "lleno") showForm(status === "lleno");
      else showClosed(status);
    });
  }

  function showClosed(status: "cerrado" | "pausa" | "unavailable"): void {
    clear(body);
    const again = el("button", { class: "button button-primary", attrs: { type: "button" }, on: { click: showStatus } }, "Comprobar otra vez");
    body.append(el("p", { class: "pass-state", attrs: { role: "alert" } }, STATUS_TEXT[status]), el("div", { class: "landing-actions" }, again, backButton));
  }

  function showForm(full: boolean): void {
    const mine = round;
    clear(body);
    let result: string | null = null;
    let sending = false;
    /** «Continuar» was pressed before the check finished: send as soon as it does. */
    let waiting = false;

    const consentId = uniqueId("consent");
    const emailId = uniqueId("email");
    const privacyId = uniqueId("privacy");
    const consent = el("input", { id: consentId, attrs: { type: "checkbox", required: true } });
    const email = el("input", {
      id: emailId,
      class: "pass-email",
      attrs: { type: "email", autocomplete: "email", inputmode: "email", required: true, maxlength: 254, spellcheck: "false" },
    });
    const challengeHost = el("div", { class: "pass-challenge" });
    const message = el("p", { class: "pass-message", attrs: { role: "status", "aria-live": "polite" } });
    const submit = el("button", { class: "button button-primary", attrs: { type: "submit" } }, "Continuar al login");

    const say = (text: string): void => {
      message.textContent = text;
    };

    /** A result is single use: after any refusal the check starts over. */
    function freshCheck(): void {
      result = null;
      widget?.reset();
    }

    async function send(): Promise<void> {
      if (sending) return;
      if (!consent.checked) return say("Para seguir tienes que aceptar el aviso de privacidad.");
      const address = normalizeEmail(email.value);
      if (address === null) return say("Escribe el correo de tu cuenta de MAPIT.");
      if (result === null) {
        waiting = true;
        return say(CHECKING);
      }
      waiting = false;
      sending = true;
      submit.disabled = true;
      say("Comprobando…");
      const outcome = await requestPass(access.passUrl, address, result, deps);
      if (disposed || mine !== round) return;
      if (outcome === "issued") {
        // Nothing of the form stays in the page the browser may keep for «Atrás».
        email.value = "";
        consent.checked = false;
        result = null;
        dropWidget();
        clear(body);
        body.append(el("p", { class: "loading", attrs: { role: "status" } }, "Abriendo el login…"));
        options.startLogin(address).catch((error: unknown) => {
          if (!disposed) options.onFailure(error);
        });
        return;
      }
      sending = false;
      submit.disabled = false;
      freshCheck();
      say(PASS_TEXT[outcome]);
    }

    const form = el(
      "form",
      {
        class: "pass-form",
        attrs: { novalidate: true, "aria-labelledby": titleId },
        on: {
          submit: (event: Event) => {
            // Never a real form submission: the policy has form-action 'none'.
            event.preventDefault();
            void send();
          },
        },
      },
      el("p", { class: "pass-field" }, el("label", { attrs: { for: emailId } }, "Correo de tu cuenta de MAPIT"), email),
      el("p", { class: "pass-lead" }, "La contraseña la escribes después, en el login del servicio: esta web no la ve."),
      el("p", { class: "pass-check" }, consent, el("label", { attrs: { for: consentId } }, " Acepto el aviso de privacidad.")),
      el(
        "details",
        { id: privacyId, class: "pass-privacy" },
        el("summary", {}, "Leer el aviso de privacidad"),
        ...CONSENT_TEXT.map((line) => el("p", {}, line)),
      ),
      challengeHost,
      message,
      el("div", { class: "landing-actions" }, submit, backButton),
    );
    if (full) body.append(el("p", { class: "pass-state", attrs: { role: "note" } }, STATUS_TEXT.lleno));
    body.append(form);

    options
      .renderChallenge(challengeHost, access.turnstileSiteKey, {
        onResult: (value) => {
          result = value;
          if (waiting) void send();
        },
        onExpired: () => {
          result = null;
        },
        onError: () => {
          result = null;
          waiting = false;
          say(CHALLENGE_FAILED);
        },
      })
      .then(
        (made) => {
          if (disposed || mine !== round) made.remove();
          else widget = made;
        },
        () => {
          waiting = false;
          if (!disposed) say(CHALLENGE_FAILED);
        },
      );
  }

  // Back from the login with «Atrás», the browser may restore this page from
  // its cache: start over with a fresh status, form and check.
  const onPageShow = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted && !disposed) {
      dropWidget();
      showStatus();
    }
  };
  window.addEventListener("pageshow", onPageShow);

  showStatus();
  return () => {
    disposed = true;
    window.removeEventListener("pageshow", onPageShow);
    dropWidget();
  };
}

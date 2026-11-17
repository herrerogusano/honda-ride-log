/**
 * The screen before the login of the open service (docs/PLAN.md, section
 * 18). It is shown instead of going straight to the login when a build has
 * `access: "public"`:
 *
 * 1. `GET /estado`: `abierto` or `lleno` show the form, `cerrado` and
 *    `pausa` say so and offer nothing to send.
 * 2. The form: the email with two help lines, a checkbox for the privacy
 *    notice (folded below it) and the Turnstile check. "Continuar" sends
 *    `POST /pase`.
 * 3. With a pass, the login starts with the email as `login_hint`.
 *
 * The email lives in the field and in one request; it is never stored. A
 * Turnstile result is single use, so after any refusal the check starts over.
 * The texts are the final ones approved by the owner (docs/PLAN.md, section 18).
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
 * Version of the privacy notice below. It does not travel to the service:
 * the service writes its own constant (`PUBLIC_CONSENT_VERSION` in
 * `honda-mapit-mcp`) in the row of each new person, and the two must name
 * the same text. Change both together whenever the notice changes.
 */
export const PRIVACY_NOTICE_VERSION = "web-1";

/** The privacy notice, folded under the checkbox; the screen stays one short view. */
export const CONSENT_TEXT: readonly string[] = [
  "Esta web no es de Honda ni de MAPIT. Usarla con tu cuenta es decisión tuya: MAPIT podría bloquear o cancelar cuentas según sus condiciones. Tu correo y tu contraseña se escriben en la página de acceso del servicio (en AWS, Irlanda). La primera vez se comprueban con MAPIT; mientras estás dentro, la página de acceso guarda tu contraseña protegida y la borra con tu usuario. Esta web no ve la contraseña.",
  "Mientras estás dentro, el servicio guarda tu sesión de MAPIT cifrada y tu usuario de acceso. Se borran al salir y, si no sales, solos antes de una hora. Para contar plazas guarda una huella de tu correo (no el correo), con las fechas y el número de entradas. Caduca un año después de tu última entrada y se borra en los días siguientes, o al momento con «Borrar mis datos».",
  "Si MAPIT rechaza tu contraseña, se cuentan los intentos con esa huella durante 24 horas. Para frenar abusos se cuentan también, durante unos minutos, los pases pedidos desde tu conexión, con una huella de esa conexión. Los dos recuentos caducan solos y se borran en los días siguientes; «Borrar mis datos» no los borra.",
  "Solo se leen tus datos de MAPIT; nunca se cambian. Tu correo solo se guarda con tu usuario de acceso, mientras estás dentro. Las cifras de uso del servicio son totales, sin correos. Antes de entrar, Cloudflare comprueba que no eres un robot.",
];

/** Where requests about one's data go: the repository's public issues page. */
export const PRIVACY_CONTACT_URL = "https://github.com/herrerogusano/honda-ride-log/issues";

/** Under the email: the two messages of the login page that this web cannot change. */
export const LOGIN_HELP: readonly string[] = [
  "En la página de acceso usa este mismo correo (si lo cambias, empieza otra vez aquí). Tienes 3 intentos de contraseña; después vuelve aquí. Esta web no ve tu contraseña.",
];

/** The button that leaves for the login page: it says what is typed there. */
export const CONTINUE_LABEL = "Continuar: escribe tu correo y contraseña de MAPIT";

const STATUS_TEXT: Readonly<Record<Exclude<AccessStatus, "abierto">, string>> = {
  lleno: "No quedan plazas para personas nuevas. Si ya has entrado antes, puedes seguir haciéndolo. Si no, puedes ver la demo.",
  cerrado: "Ahora mismo no se puede entrar. Prueba más adelante.",
  pausa: MAINTENANCE_TEXT,
  unavailable: "No se ha podido comprobar si se puede entrar. Revisa la conexión y prueba otra vez.",
};

const PASS_TEXT: Readonly<Record<Exclude<PassOutcome, "issued">, string>> = {
  bad_request: "El servicio no acepta este correo. Revísalo y vuelve a probar.",
  rejected: "La comprobación anti-robots no es válida o ha caducado. Pulsa «Continuar» otra vez; si se repite, recarga la página.",
  rate_limited: "Demasiados intentos desde esta conexión. Espera unos 10 minutos.",
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
    const submit = el("button", { class: "button button-primary pass-continue", attrs: { type: "submit" } }, CONTINUE_LABEL);

    const say = (text: string): void => {
      message.textContent = text;
    };

    /** A result is single use: after any refusal the check starts over. */
    function freshCheck(): void {
      result = null;
      widget?.reset();
    }

    /** True while this form is the one on screen: not left with «Volver», not replaced after a restore from cache. */
    const current = (): boolean => !disposed && mine === round;

    async function send(): Promise<void> {
      // A late callback of an abandoned form never sends anything.
      if (!current()) return;
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
      if (!current()) return;
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
      ...LOGIN_HELP.map((line) => el("p", { class: "pass-lead" }, line)),
      el("p", { class: "pass-check" }, consent, el("label", { attrs: { for: consentId } }, " Acepto el aviso de privacidad.")),
      el(
        "details",
        { id: privacyId, class: "pass-privacy" },
        el("summary", {}, "Leer el aviso de privacidad"),
        ...CONSENT_TEXT.map((line) => el("p", {}, line)),
        el(
          "p",
          {},
          "Para cualquier petición sobre tus datos, abre una incidencia en ",
          el("a", { attrs: { href: PRIVACY_CONTACT_URL, target: "_blank", rel: "noopener noreferrer" } }, "github.com/herrerogusano/honda-ride-log/issues"),
          ". Es pública: no escribas en ella tu correo ni datos de tu cuenta.",
        ),
      ),
      challengeHost,
      message,
      el("div", { class: "landing-actions" }, submit, backButton),
    );
    // The pass goes out by itself only for what was confirmed with «Continuar»:
    // editing the email or the consent while the check runs cancels that wait.
    const cancelWait = (): void => {
      if (!waiting) return;
      waiting = false;
      say("");
    };
    email.addEventListener("input", cancelWait);
    consent.addEventListener("change", cancelWait);

    if (full) body.append(el("p", { class: "pass-state", attrs: { role: "note" } }, STATUS_TEXT.lleno));
    body.append(form);

    options
      .renderChallenge(challengeHost, access.turnstileSiteKey, {
        onResult: (value) => {
          if (!current()) return;
          result = value;
          if (waiting) void send();
        },
        onExpired: () => {
          result = null;
        },
        onError: () => {
          if (!current()) return;
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

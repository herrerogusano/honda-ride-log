/** Spanish text for a failed load. Shows a code, never a message from the service. */
import type { FailureKind, LoadError, LoadStep } from "../service/loader";

const STEP_TEXT: Readonly<Record<LoadStep, string>> = {
  login: "No se ha podido entrar.",
  vehicles: "No se ha podido leer la lista de motos de tu cuenta.",
  status: "No se ha podido leer el estado de la moto.",
  details: "No se han podido leer los datos del vehículo.",
  routes: "No se han podido cargar las rutas.",
  detail: "No se ha podido cargar el recorrido de esta ruta.",
};

/**
 * What the page offers after a failure:
 * - `retry`: the same request again. Only where the same token can succeed.
 * - `sign_in`: a new sign-in. The session is over (the client never sends a
 *   rejected token again), so retrying would fail the same way.
 * - `none`: nothing the user can do from here.
 */
export type ErrorAction = "retry" | "sign_in" | "none";

const KIND: Readonly<Record<FailureKind, { readonly text: string; readonly action: ErrorAction }>> = {
  tool_error: { text: "El servicio ha respondido con un error.", action: "retry" },
  unexpected_shape: { text: "El servicio ha respondido con un formato que esta web no espera.", action: "retry" },
  too_many_routes: { text: "Hay más rutas en un mismo instante de las que el servicio entrega de una vez.", action: "retry" },
  cancelled: { text: "La carga se ha interrumpido antes de terminar.", action: "retry" },
  unknown: { text: "Ha fallado algo inesperado.", action: "retry" },

  // Sign-in (src/auth/login.ts).
  config_missing: { text: "Esta versión de la web no tiene configurado el acceso con cuenta. Solo está disponible la demo.", action: "none" },
  storage_unavailable: {
    text: "Tu navegador no deja guardar el inicio de sesión durante la ida y vuelta al login (pasa en algunos modos privados estrictos).",
    action: "none",
  },
  state_mismatch: {
    text: "La vuelta del login no corresponde a un inicio de sesión de esta pestaña, o ha tardado más de 10 minutos. Vuelve a entrar.",
    action: "sign_in",
  },
  login_failed: { text: "El login no ha dado acceso. Vuelve a entrar.", action: "sign_in" },
  token_exchange: { text: "El login no ha entregado un acceso válido. Vuelve a entrar.", action: "sign_in" },
  token_network: { text: "No se ha podido conectar con el login. Comprueba la conexión y vuelve a entrar.", action: "sign_in" },

  // Transport of the real /mcp client (src/service/mcpClient.ts).
  reauth_required: { text: "Tu sesión ha caducado o el servicio ya no la acepta. Vuelve a entrar.", action: "sign_in" },
  forbidden: { text: "Tu cuenta no tiene acceso a este servicio. Si crees que es un error, vuelve a entrar.", action: "sign_in" },
  rate_limited: { text: "El servicio ha recibido demasiadas peticiones. Espera un momento y reintenta.", action: "retry" },
  http_status: { text: "El servicio ha respondido con un error.", action: "retry" },
  timeout: { text: "El servicio tarda demasiado en responder.", action: "retry" },
  bad_response: { text: "El servicio ha respondido con algo que esta web no espera.", action: "retry" },
  rpc_error: { text: "El servicio ha rechazado la petición.", action: "retry" },
  not_allowed: { text: "Fallo de esta web: ha intentado una petición que no tiene permitida.", action: "none" },
};

export interface ErrorText {
  readonly title: string;
  readonly explanation: string;
  /** For example `routes/tool_error (period_too_large)`. Safe to show and to copy into a bug report. */
  readonly code: string;
  readonly action: ErrorAction;
}

/** A pause of the open service (maintenance or its daily ceiling), on the pass screen and after a call. */
export const MAINTENANCE_TEXT = "El servicio está en pausa. Vuelve más tarde.";

/**
 * Tool error codes of the open service (docs/PLAN.md, section 18), read only
 * in a build for it: an invitation build keeps the general text of
 * `tool_error`, except for `session_expired` (below).
 */
const PUBLIC_TOOL_CODES: Readonly<Record<string, { readonly text: string; readonly action: ErrorAction }>> = {
  service_paused: { text: MAINTENANCE_TEXT, action: "retry" },
  session_expired: { text: "Tu sesión ha terminado: dura menos de una hora y después se borra sola. Vuelve a entrar.", action: "sign_in" },
  session_limit_reached: { text: "Has llegado al máximo de consultas de esta sesión. Vuelve a entrar.", action: "sign_in" },
  rate_limited: { text: "Demasiadas consultas seguidas. Espera un minuto y reintenta.", action: "retry" },
  service_unavailable: { text: "El servicio no está disponible ahora mismo. Prueba de nuevo dentro de un rato.", action: "retry" },
};

/**
 * Tool error codes read in an invitation build. Only `session_expired`: the
 * client has forgotten the token, so a retry would fail the same way.
 */
const INVITATION_TOOL_CODES: Readonly<Record<string, { readonly text: string; readonly action: ErrorAction }>> = {
  session_expired: { text: "Tu sesión ha terminado. Vuelve a entrar.", action: "sign_in" },
};

/**
 * The vehicle choice the service did not take, in both builds. «Reintentar»
 * reads the list of motorbikes again and forgets the kept choice
 * (src/ui/app.ts).
 */
const VEHICLE_TOOL_CODES: Readonly<Record<string, { readonly text: string; readonly action: ErrorAction }>> = {
  vehicle_selection_required: {
    text: "Tu cuenta tiene varias motos y el servicio necesita saber cuál enseñar. Reintenta para volver a leer la lista de motos.",
    action: "retry",
  },
  vehicle_not_found: {
    text: "Esa moto ya no aparece en tu cuenta. Reintenta para volver a leer la lista de motos.",
    action: "retry",
  },
};

export function errorText(error: LoadError, publicService = false): ErrorText {
  const code = error.detail;
  const codes = { ...VEHICLE_TOOL_CODES, ...(publicService ? PUBLIC_TOOL_CODES : INVITATION_TOOL_CODES) };
  const special = error.kind === "tool_error" && code !== null && Object.hasOwn(codes, code) ? codes[code] : undefined;
  const kind = special ?? KIND[error.kind];
  return {
    title: STEP_TEXT[error.step],
    explanation: kind.text,
    code: `${error.step}/${error.kind}${error.detail === null ? "" : ` (${error.detail})`}`,
    action: kind.action,
  };
}

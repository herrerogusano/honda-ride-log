/** Spanish text for a failed load. Shows a code, never a message from the service. */
import type { FailureKind, LoadError, LoadStep } from "../service/loader";

const STEP_TEXT: Readonly<Record<LoadStep, string>> = {
  login: "No se ha podido entrar.",
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

export function errorText(error: LoadError): ErrorText {
  const kind = KIND[error.kind];
  return {
    title: STEP_TEXT[error.step],
    explanation: kind.text,
    code: `${error.step}/${error.kind}${error.detail === null ? "" : ` (${error.detail})`}`,
    action: kind.action,
  };
}

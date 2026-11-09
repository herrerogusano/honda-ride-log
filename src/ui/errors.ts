/** Spanish text for a failed load. Shows a code, never a message from the service. */
import type { FailureKind, LoadError, LoadStep } from "../service/loader";

const STEP_TEXT: Readonly<Record<LoadStep, string>> = {
  status: "No se ha podido leer el estado de la moto.",
  details: "No se han podido leer los datos del vehículo.",
  routes: "No se han podido cargar las rutas.",
  detail: "No se ha podido cargar el recorrido de esta ruta.",
};

const KIND_TEXT: Readonly<Record<FailureKind, string>> = {
  tool_error: "El servicio ha respondido con un error.",
  unexpected_shape: "El servicio ha respondido con un formato que esta web no espera.",
  too_many_routes: "Hay más rutas en un mismo instante de las que el servicio entrega de una vez.",
  unknown: "Ha fallado algo inesperado.",
};

export interface ErrorText {
  readonly title: string;
  readonly explanation: string;
  /** For example `routes/tool_error (period_too_large)`. Safe to show and to copy into a bug report. */
  readonly code: string;
}

export function errorText(error: LoadError): ErrorText {
  return {
    title: STEP_TEXT[error.step],
    explanation: KIND_TEXT[error.kind],
    code: `${error.step}/${error.kind}${error.detail === null ? "" : ` (${error.detail})`}`,
  };
}

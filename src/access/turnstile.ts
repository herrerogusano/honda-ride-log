/**
 * The Cloudflare Turnstile check of the open service (docs/PLAN.md, section
 * 18): the only third party the pass screen loads.
 *
 * Its script is requested only when the pass screen is shown, never on the
 * landing, the demo or the rider's page, and only in a build for the open
 * service (the security policy of any other build does not even allow its
 * origin). It renders explicitly into one container with the action the
 * service checks (`web-pass`). The page reads one thing back: the result
 * string, which goes straight into `POST /pase`.
 */

/** The one script, with explicit rendering (no automatic scan of the page). */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** The service accepts a result only for this action (`TURNSTILE_ACTION` of the pass function). */
export const TURNSTILE_ACTION = "web-pass";

export interface ChallengeCallbacks {
  /** The check passed: `result` is single use and expires in about 5 minutes. */
  onResult(result: string): void;
  /** The result expired before it was used: the check asks again by itself. */
  onExpired(): void;
  /** The check failed or could not run (network, blocked, browser not supported). */
  onError(): void;
}

export interface ChallengeWidget {
  /** A fresh check, for example after the service refused or used the result. */
  reset(): void;
  /** Takes the widget out of the page. */
  remove(): void;
}

/** Renders a check into `host`. Rejects if the script cannot be loaded. */
export type ChallengeRenderer = (host: HTMLElement, siteKey: string, callbacks: ChallengeCallbacks) => Promise<ChallengeWidget>;

interface TurnstileApi {
  render(host: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

let loading: Promise<TurnstileApi> | null = null;

function turnstileApi(): TurnstileApi | null {
  const api = (globalThis as { turnstile?: unknown }).turnstile;
  return typeof api === "object" && api !== null && typeof (api as TurnstileApi).render === "function" ? (api as TurnstileApi) : null;
}

/** Loads the script once per page. A failed load can be tried again. */
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener("load", () => {
      const api = turnstileApi();
      if (api === null) reject(new Error("turnstile_missing"));
      else resolve(api);
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("turnstile_unavailable"));
    });
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The real check, with Cloudflare's script. */
export const renderTurnstile: ChallengeRenderer = async (host, siteKey, callbacks) => {
  const api = await loadTurnstile();
  const widgetId = api.render(host, {
    sitekey: siteKey,
    action: TURNSTILE_ACTION,
    language: "es",
    theme: "dark",
    // The normal widget is 300 px wide; on the narrowest phones it would stick out.
    size: host.clientWidth > 0 && host.clientWidth < 300 ? "compact" : "normal",
    // The page reads the result from the callback; no hidden form field.
    "response-field": false,
    callback: (result: unknown) => {
      if (typeof result === "string") callbacks.onResult(result);
    },
    "expired-callback": () => callbacks.onExpired(),
    "timeout-callback": () => callbacks.onExpired(),
    "error-callback": () => {
      callbacks.onError();
      // Handled here: the page says what happened.
      return true;
    },
  });
  if (typeof widgetId !== "string") throw new Error("turnstile_render");
  return {
    reset: () => api.reset(widgetId),
    remove: () => api.remove(widgetId),
  };
};

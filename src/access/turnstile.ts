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
/** How long the script may take to arrive before the page says the check could not load. */
export const SCRIPT_TIMEOUT_MS = 15_000;

function turnstileApi(): TurnstileApi | null {
  const api = (globalThis as { turnstile?: unknown }).turnstile;
  return typeof api === "object" && api !== null && typeof (api as TurnstileApi).render === "function" ? (api as TurnstileApi) : null;
}

/**
 * The one script element. It stays after a deadline passes: removing it
 * would not cancel the request, and a second element could run the script
 * twice. A retry waits on the same element; only a failed one is replaced.
 */
let element: HTMLScriptElement | null = null;

/** Loads the script once per page. A failed or late load can be tried again. */
function loadTurnstile(): Promise<TurnstileApi> {
  // A script that arrived after an earlier deadline is already there.
  const ready = turnstileApi();
  if (ready !== null) return Promise.resolve(ready);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (element === null || !element.isConnected) {
      const created = document.createElement("script");
      created.src = TURNSTILE_SCRIPT;
      created.async = true;
      created.addEventListener("error", () => {
        created.remove();
        if (element === created) element = null;
      });
      element = created;
      document.head.append(created);
    }
    const script = element;
    const settle = (): void => {
      clearTimeout(deadline);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
    const onLoad = (): void => {
      settle();
      const api = turnstileApi();
      if (api === null) reject(new Error("turnstile_missing"));
      else resolve(api);
    };
    const onError = (): void => {
      settle();
      reject(new Error("turnstile_unavailable"));
    };
    // A stalled request must not leave the form waiting for ever.
    const deadline = setTimeout(() => {
      settle();
      reject(new Error("turnstile_unavailable"));
    }, SCRIPT_TIMEOUT_MS);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
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
    // Seen only if Cloudflare needs the visitor to act; usually it resolves
    // without showing anything ("The widget becomes visible only when visitor
    // interaction is required", Turnstile widget configurations).
    appearance: "interaction-only",
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

/**
 * The signed-in state: the access token, in a closure variable and nowhere
 * else (docs/PLAN.md, "Almacenamiento"). It is not a property, so logging,
 * serializing or spreading a session does not reveal it. There is no refresh:
 * when the token expires or the service rejects it, the session ends and the
 * user signs in again.
 */

/** Stop using a token this long before it expires, to absorb clock skew and latency. */
export const EXPIRY_MARGIN_MS = 60_000;

export type EndReason = "expired" | "unauthorized" | "forbidden" | "network" | "signed_out";

/** Runs `run` once after `delayMs`; the returned function cancels it. Tests pass their own. */
export type Schedule = (run: () => void, delayMs: number) => () => void;

/**
 * Longest delay `setTimeout` honours (2^31 − 1 ms, about 24.8 days); browsers
 * run a longer one at once. The expiry check asks again when it fires early.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const defaultSchedule: Schedule = (run, delayMs) => {
  const id = setTimeout(run, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  return () => clearTimeout(id);
};

export interface AuthSession {
  /** `Bearer <token>` while the session is usable at `nowMs`, else null (and the session ends if expired). */
  authorization(nowMs: number): string | null;
  /** Forgets the token. Later calls of `authorization` return null. */
  end(reason: EndReason): void;
  /** Why the session ended, or null while it is active. */
  readonly endReason: EndReason | null;
  /**
   * Calls `listener` once when the session ends, whatever the reason (the
   * page forgets the whole traces it holds, docs/PLAN.md section 4). A
   * listener added after the end is called at once.
   */
  onEnd(listener: (reason: EndReason) => void): void;
  /**
   * Ends the session on its own when the token expires (with the same
   * margin as `authorization`), even if no request is made. The timer is
   * cancelled when the session ends for any other reason.
   */
  watchExpiry(now: () => number, schedule?: Schedule): void;
}

export function createSession(accessToken: string, expiresAtMs: number): AuthSession {
  let token: string | null = accessToken;
  let reason: EndReason | null = null;
  let listeners: ((reason: EndReason) => void)[] = [];
  let stopWatch: (() => void) | null = null;
  const session: AuthSession = {
    authorization(nowMs) {
      if (token !== null && nowMs >= expiresAtMs - EXPIRY_MARGIN_MS) session.end("expired");
      return token === null ? null : `Bearer ${token}`;
    },
    end(why) {
      if (token === null) return;
      token = null;
      reason = why;
      stopWatch?.();
      stopWatch = null;
      const waiting = listeners;
      listeners = [];
      for (const listener of waiting) listener(why);
    },
    get endReason() {
      return reason;
    },
    onEnd(listener) {
      if (reason !== null) listener(reason);
      else listeners.push(listener);
    },
    watchExpiry(now, schedule = defaultSchedule) {
      stopWatch?.();
      stopWatch = null;
      if (token === null) return;
      const check = (): void => {
        stopWatch = null;
        // `authorization` ends the session once the margin is reached; a clock that runs late is asked again.
        if (session.authorization(now()) !== null) stopWatch = schedule(check, Math.max(1_000, expiresAtMs - EXPIRY_MARGIN_MS - now()));
      };
      stopWatch = schedule(check, Math.max(0, expiresAtMs - EXPIRY_MARGIN_MS - now()));
    },
  };
  return Object.freeze(session);
}

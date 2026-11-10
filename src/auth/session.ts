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

export interface AuthSession {
  /** `Bearer <token>` while the session is usable at `nowMs`, else null (and the session ends if expired). */
  authorization(nowMs: number): string | null;
  /** Forgets the token. Later calls of `authorization` return null. */
  end(reason: EndReason): void;
  /** Why the session ended, or null while it is active. */
  readonly endReason: EndReason | null;
}

export function createSession(accessToken: string, expiresAtMs: number): AuthSession {
  let token: string | null = accessToken;
  let reason: EndReason | null = null;
  const session: AuthSession = {
    authorization(nowMs) {
      if (token !== null && nowMs >= expiresAtMs - EXPIRY_MARGIN_MS) session.end("expired");
      return token === null ? null : `Bearer ${token}`;
    },
    end(why) {
      if (token === null) return;
      token = null;
      reason = why;
    },
    get endReason() {
      return reason;
    },
  };
  return Object.freeze(session);
}

// How the errors of the sign-in and of the /mcp client reach the screen:
// src/service/loader.ts turns them into a LoadError with a closed kind, and
// src/ui/errors.ts gives each kind a text and an action. In memory only.
import { describe, expect, it } from "vitest";
import { AuthError, type AuthErrorKind } from "../src/auth/login";
import { createSession } from "../src/auth/session";
import { ToolCallError } from "../src/service/contract";
import { loadVehicleState, LoadError, signInError, type FailureKind } from "../src/service/loader";
import { ServiceError, type ServiceErrorKind } from "../src/service/mcpClient";
import { errorText } from "../src/ui/errors";

const AUTH_KINDS: readonly AuthErrorKind[] = ["config_missing", "storage_unavailable", "state_mismatch", "login_failed", "token_exchange", "token_network"];
const SERVICE_KINDS: readonly ServiceErrorKind[] = [
  "reauth_required",
  "forbidden",
  "rate_limited",
  "http_status",
  "timeout",
  "bad_response",
  "rpc_error",
  "not_allowed",
];

const failing = (error: unknown) => ({ callTool: async () => Promise.reject(error) });
async function statusError(error: unknown): Promise<LoadError> {
  const caught = await loadVehicleState(failing(error)).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(caught).toBeInstanceOf(LoadError);
  return caught as LoadError;
}

describe("errors of the sign-in and of the /mcp client", () => {
  it.each(SERVICE_KINDS)("keep the service kind %s with its step", async (kind) => {
    const error = await statusError(new ServiceError(kind, null));
    expect([error.step, error.kind, error.detail]).toEqual(["status", kind, null]);
  });

  it.each(AUTH_KINDS)("keep the sign-in kind %s under the login step", (kind) => {
    const error = signInError(new AuthError(kind, null));
    expect([error.step, error.kind, error.detail]).toEqual(["login", kind, null]);
  });

  it("keep short codes and numbers as the detail", async () => {
    expect(errorText(await statusError(new ServiceError("reauth_required", "unauthorized"))).code).toBe("status/reauth_required (unauthorized)");
    expect(errorText(await statusError(new ServiceError("http_status", "503"))).code).toBe("status/http_status (503)");
    expect(errorText(await statusError(new ServiceError("rpc_error", "-32601"))).code).toBe("status/rpc_error (-32601)");
    expect(errorText(signInError(new AuthError("token_exchange", "http_502"))).code).toBe("login/token_exchange (http_502)");
  });

  it("drop a detail that does not look like a code, whoever wrote it", async () => {
    const leaks = ["eyJhbGciOi.payload.sig", "https://login.example.test/oauth2/token", "rider@example.test", "Bearer abc", "1234567"];
    for (const leak of leaks) {
      expect((await statusError(new ServiceError("http_status", leak))).detail).toBeNull();
      expect(signInError(new AuthError("login_failed", leak)).detail).toBeNull();
    }
  });

  it("an unknown failure on the way in keeps only its class name", () => {
    const error = signInError(new TypeError("https://login.example.test/?code=secret"));
    expect([error.step, error.kind, error.detail]).toEqual(["login", "unknown", "TypeError"]);
    expect(error.message).not.toContain("secret");
  });

  it("a call after sign-out ends as reauth_required, not as unknown", async () => {
    const session = createSession("synthetic.token.value.long-enough", Date.now() + 3_600_000);
    session.end("signed_out");
    const error = await statusError(new ServiceError("reauth_required", session.endReason));
    expect(errorText(error).code).toBe("status/reauth_required (signed_out)");
  });
});

describe("what the page offers after each failure", () => {
  const action = (kind: FailureKind) => errorText(new LoadError("routes", kind, null)).action;

  it("asks to sign in again, never to retry, when the session is over or the login failed", () => {
    for (const kind of ["reauth_required", "forbidden", "state_mismatch", "login_failed", "token_exchange", "token_network"] as const) {
      expect([kind, action(kind)]).toEqual([kind, "sign_in"]);
    }
  });

  it("offers to retry what the same token can get past", () => {
    for (const kind of ["tool_error", "unexpected_shape", "too_many_routes", "cancelled", "unknown", "rate_limited", "http_status", "timeout", "bad_response", "rpc_error"] as const) {
      expect([kind, action(kind)]).toEqual([kind, "retry"]);
    }
  });

  it("offers nothing where nothing helps", () => {
    for (const kind of ["config_missing", "storage_unavailable", "not_allowed"] as const) expect([kind, action(kind)]).toEqual([kind, "none"]);
  });

  it("says «Vuelve a entrar» for the session and login failures", () => {
    for (const kind of ["reauth_required", "state_mismatch", "login_failed", "token_exchange", "token_network"] as const) {
      expect(errorText(new LoadError("status", kind, null)).explanation).toMatch(/vuelve a entrar/i);
    }
  });

  it("gives every kind its own sentence", () => {
    const kinds: FailureKind[] = ["tool_error", "unexpected_shape", "too_many_routes", "cancelled", "unknown", ...AUTH_KINDS, ...SERVICE_KINDS];
    const texts = kinds.filter((kind) => kind !== "http_status").map((kind) => errorText(new LoadError("routes", kind, null)).explanation);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("still shows a tool's own code as before", async () => {
    const error = await statusError(new ToolCallError("period_too_large", "message with data"));
    expect(errorText(error)).toEqual({
      title: "No se ha podido leer el estado de la moto.",
      explanation: "El servicio ha respondido con un error.",
      code: "status/tool_error (period_too_large)",
      action: "retry",
    });
  });
});

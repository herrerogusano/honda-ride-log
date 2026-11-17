/**
 * Joins the sign-in and the `/mcp` client (phase 3) with the page (phase 2),
 * as docs/PLAN.md section 10 ("Cómo se conecta con la interfaz") describes.
 *
 * - A demo-only build (no service in `environments.config.json`) starts the
 *   page exactly as before: landing or demo, and no sign-in button.
 * - A build with a service first completes a return from the login, if the
 *   address is one: `completeLogin` takes `?code` and `?state` out of the
 *   address before anything else runs, and before the page reads the
 *   fragment. Then the page starts; with a session it loads the account
 *   through the real client, with `demo: false`.
 *
 * The session lives here and in the client only, in memory. Signing out
 * forgets it; the page drops the data and stops the load.
 *
 * The visit counters (docs/PLAN.md, section 17) start only after that
 * return has been dealt with, so neither ever runs with `?code` in the
 * address; then "signed in" is counted once the code became a session.
 */
import { completeLogin, logout, startLogin, type AuthDeps, type LoginReturn } from "./auth/login";
import type { AuthSession } from "./auth/session";
import type { ServiceEnvironment } from "./service/environment";
import { signInError, type LoadError } from "./service/loader";
import { ToolCallError } from "./service/contract";
import { createMcpClient, ServiceError, type McpClient, type McpClientOptions } from "./service/mcpClient";
import { renderTurnstile, type ChallengeRenderer } from "./access/turnstile";
import { clear, el } from "./ui/dom";
import { showPassScreen } from "./ui/passScreen";
import { startApp, type App, type AppOptions } from "./ui/app";
import type { Counter } from "./analytics/config";

/** What `boot` needs of the visit counters (`createTracker` in the page, a fake in tests). */
export type BootAnalytics = Counter;

export interface BootOptions extends Omit<AppOptions, "account" | "initialView" | "onDemo"> {
  readonly environment: ServiceEnvironment;
  /** Browser objects of the sign-in; `browserDeps()` in the page, fakes in tests. Unused in demo. */
  readonly auth: () => AuthDeps;
  /** Only for tests: the `/mcp` client's fetch, clock and pacing. */
  readonly mcp?: McpClientOptions;
  /** The visit counters; none if left out. */
  readonly analytics?: BootAnalytics;
  /** Only for tests: the anti-robot check of the open service (Cloudflare Turnstile in the page). */
  readonly challenge?: ChallengeRenderer;
}

export async function boot(options: BootOptions): Promise<App> {
  const { environment, auth, mcp, analytics, challenge, ...rest } = options;
  const appOptions: Omit<AppOptions, "account" | "initialView"> = { ...rest, onDemo: () => analytics?.track("demo_open") };
  if (environment.kind === "demo") {
    // No login in this build, so the address never carries a code.
    analytics?.start();
    return startApp(appOptions);
  }

  const { config } = environment;
  const deps = auth();
  let session: AuthSession | null = null;
  let client: McpClient | null = null;
  const access = config.publicAccess;

  // Only visible while the token exchange is on its way; when the address
  // is not a return from the login, the page replaces it before any paint.
  clear(appOptions.root);
  appOptions.root.append(el("p", { class: "loading", attrs: { role: "status" } }, "Comprobando el acceso…"));

  let back: LoginReturn = { status: "none" };
  let failure: LoadError | null = null;
  try {
    back = await completeLogin(config, deps);
  } catch (error) {
    failure = signInError(error);
  }
  // Only now: `completeLogin` has taken the login parameters out of the address.
  analytics?.start();
  if (back.status === "signed_in") analytics?.track("login");

  const app = startApp({
    ...appOptions,
    // A return from the login (good or bad) decides the first view; the
    // fragment does not, so `#demo` cannot replace the account.
    initialView: back.status === "signed_in" || failure !== null ? "none" : "address",
    account:
      access === null
        ? {
            signIn: () => startLogin(config, deps),
            signOut: () => {
              const ending = session;
              session = null;
              client = null;
              logout(config, ending, deps);
              return null;
            },
          }
        : {
            signIn: () => startLogin(config, deps),
            signOut: () => leave((open) => open.endSession(), signOutProblem),
            publicService: {
              showAccess: (view) =>
                showPassScreen({
                  host: view.host,
                  access,
                  deps: { fetch: deps.fetch },
                  renderChallenge: challenge ?? renderTurnstile,
                  startLogin: (email) => startLogin(config, deps, email),
                  onBack: view.back,
                  onFailure: view.fail,
                }),
              deleteMyData: () => leave((open) => open.deleteMyData(), deleteProblem),
            },
          },
  });

  /**
   * The open service: one account tool with the token, then the token goes.
   * Done, the browser also leaves for the login's sign-out page (if the build
   * knows one). Failed, the token is forgotten here all the same and the
   * landing says what happened; the service deletes every session by itself
   * in less than one hour.
   */
  async function leave(run: (open: McpClient) => Promise<void>, problem: (error: unknown) => string): Promise<string | null> {
    const ending = session;
    const open = client;
    session = null;
    client = null;
    let text: string | null = null;
    if (ending === null || open === null || ending.endReason !== null) {
      text = problem(null);
    } else {
      try {
        await run(open);
      } catch (error) {
        text = problem(error);
      }
    }
    logout(text === null ? config : { ...config, logoutUri: null }, ending, deps);
    return text;
  }

  if (failure !== null) {
    app.showLanding(failure);
  } else if (back.status === "signed_in") {
    session = back.session;
    client = createMcpClient(config.mcpUrl, back.session, { ...mcp, publicService: access !== null });
    void app.load(client, { demo: false });
  }
  return app;
}

/** A closed code for a failed account tool: the tool's own code or the transport kind. */
function failureCode(error: unknown): string {
  if (error instanceof ToolCallError) return error.code;
  if (error instanceof ServiceError) return error.kind;
  return "unknown";
}

/** Provisional texts (docs/PLAN.md, section 18). `null`: the session had already ended. */
function signOutProblem(error: unknown): string {
  if (error === null) return "Tu sesión ya había terminado. En el servicio se borra sola en menos de una hora.";
  return `No se ha podido cerrar la sesión del todo en el servicio (código: ${failureCode(error)}). Se borrará sola en menos de una hora.`;
}

function deleteProblem(error: unknown): string {
  const again = "Entra de nuevo y repite «Borrar mis datos».";
  if (error === null) return `No se han podido borrar tus datos porque tu sesión ya había terminado. ${again}`;
  return `No se han podido borrar tus datos (código: ${failureCode(error)}). Tu sesión en esta web se ha cerrado. ${again}`;
}

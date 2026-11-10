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
 */
import { completeLogin, logout, startLogin, type AuthDeps, type LoginReturn } from "./auth/login";
import type { AuthSession } from "./auth/session";
import type { ServiceEnvironment } from "./service/environment";
import { signInError, type LoadError } from "./service/loader";
import { createMcpClient, type McpClientOptions } from "./service/mcpClient";
import { clear, el } from "./ui/dom";
import { startApp, type App, type AppOptions } from "./ui/app";

export interface BootOptions extends Omit<AppOptions, "account" | "initialView"> {
  readonly environment: ServiceEnvironment;
  /** Browser objects of the sign-in; `browserDeps()` in the page, fakes in tests. Unused in demo. */
  readonly auth: () => AuthDeps;
  /** Only for tests: the `/mcp` client's fetch, clock and pacing. */
  readonly mcp?: McpClientOptions;
}

export async function boot(options: BootOptions): Promise<App> {
  const { environment, auth, mcp, ...appOptions } = options;
  if (environment.kind === "demo") return startApp(appOptions);

  const { config } = environment;
  const deps = auth();
  let session: AuthSession | null = null;

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

  const app = startApp({
    ...appOptions,
    // A return from the login (good or bad) decides the first view; the
    // fragment does not, so `#demo` cannot replace the account.
    initialView: back.status === "signed_in" || failure !== null ? "none" : "address",
    account: {
      signIn: () => startLogin(config, deps),
      signOut: () => {
        const ending = session;
        session = null;
        logout(config, ending, deps);
      },
    },
  });

  if (failure !== null) {
    app.showLanding(failure);
  } else if (back.status === "signed_in") {
    session = back.session;
    void app.load(createMcpClient(config.mcpUrl, back.session, mcp), { demo: false });
  }
  return app;
}

// Entry point. See docs/PLAN.md (section 10 for the sign-in).
import { browserDeps } from "./auth/login";
import { boot } from "./boot";
import { currentEnvironment } from "./service/environment";
import type { App } from "./ui/app";

/** The page, kept so that nothing is started twice. */
export let app: App | null = null;

const root = document.getElementById("app");
if (root !== null) {
  void boot({ root, environment: currentEnvironment(), auth: browserDeps }).then((started) => {
    app = started;
  });
}

// Entry point. See docs/PLAN.md (section 10 for the sign-in).
import { currentAnalytics } from "./analytics/config";
import { mountConsentNotice } from "./analytics/consentNotice";
import { createTracker } from "./analytics/tracker";
import { browserDeps } from "./auth/login";
import { boot } from "./boot";
import { currentEnvironment } from "./service/environment";
import type { App } from "./ui/app";

/** The page, kept so that nothing is started twice. */
export let app: App | null = null;

const root = document.getElementById("app");
if (root !== null) {
  // Visit counters (docs/PLAN.md, section 17): nothing loads until `boot`
  // has cleaned the address; with analytics.config.json empty, nothing at all.
  const analytics = createTracker(currentAnalytics());
  const consentHost = document.getElementById("consent");
  if (consentHost !== null) mountConsentNotice(consentHost, analytics);
  void boot({ root, environment: currentEnvironment(), auth: browserDeps, analytics }).then((started) => {
    app = started;
  });
}

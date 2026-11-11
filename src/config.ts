/**
 * Product choices the owner may still change (docs/PLAN.md, "Limitaciones
 * conocidas"). Each one is a single switch so that changing the answer is a
 * one-line edit plus its test.
 *
 * The service a build talks to is not here: it lives in
 * `environments.config.json`, read by `src/service/environment.ts`.
 */

/**
 * Do routes under 300 m count in the figures (rides, km, hours, habits)?
 * They are never listed nor drawn either way. `false`: they are left out of
 * everything and a footnote says how many there are. The MAPIT app does
 * count them, so with `false` the number of rides may differ from the app's.
 */
export const SHORT_ROUTES_COUNT_IN_FIGURES: boolean = false;

/**
 * Period the Resumen tab opens with: the current calendar year
 * (`"current_year"`) or the whole history (`"all"`). The selector always
 * offers both.
 */
export const SUMMARY_DEFAULT_PERIOD: "current_year" | "all" = "current_year";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The privacy seals are import rules: a function that opens a sealed value
 * may be imported from one place only. These tests lint small snippets as if
 * they lived in different files of the repo.
 */
const eslint = new ESLint();

async function importErrors(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-imports").length;
}

const use = (name: string, from: string): string => `import { ${name} } from "${from}";\nexport const x = ${name};\n`;

describe("privacy seals", () => {
  it("let only the trim open an untrimmed trace and read the places to hide", async () => {
    for (const name of ["untrimmedLines", "sensitivePlaces"]) {
      expect(await importErrors(use(name, "./sanitize"), "src/domain/trim.ts")).toBe(0);
      expect(await importErrors(use(name, "./sanitize"), "src/domain/stats.ts")).toBe(1);
      expect(await importErrors(use(name, "../domain/sanitize"), "src/ui/mapView.ts")).toBe(1);
      expect(await importErrors(use(name, "../domain/sanitize"), "src/service/loader.ts")).toBe(1);
      expect(await importErrors(use(name, "./domain/sanitize.ts"), "src/main.ts")).toBe(1);
    }
  }, 30_000);

  // The whole trace is drawn on the signed-in rider's screen (docs/PLAN.md,
  // section 4), so its lines leave the trim through `screenTrace`. The seals
  // on the sealed detail stay as they were; the new opening is one more
  // seal: only the trace store of the map and the atlas may import it, so
  // the shared card, the downloads, the visit counters or the map code
  // itself cannot reach a whole trace by another way.
  it("let only the trace store take the whole trace for the screen", async () => {
    expect(await importErrors(use("screenTrace", "../domain/trim"), "src/ui/traceStore.ts")).toBe(0);
    expect(await importErrors(use("trimTrace", "../domain/trim"), "src/ui/card.ts")).toBe(0);
    for (const file of ["src/ui/card.ts", "src/ui/summary.ts", "src/ui/download.ts", "src/ui/routesView.ts", "src/ui/mapView.ts", "src/ui/atlas/atlasView.ts"]) {
      expect(await importErrors(use("screenTrace", "../domain/trim"), file)).toBe(1);
    }
    expect(await importErrors(use("screenTrace", "./trim"), "src/domain/csv.ts")).toBe(1);
    expect(await importErrors(use("screenTrace", "./trim.ts"), "src/domain/stats.ts")).toBe(1);
    expect(await importErrors(use("screenTrace", "../domain/trim"), "src/analytics/tracker.ts")).toBe(1);
    expect(await importErrors(use("screenTrace", "../domain/trim"), "src/service/loader.ts")).toBe(1);
    expect(await importErrors(use("screenTrace", "./domain/trim"), "src/main.ts")).toBe(1);
    // The store may take the screen lines, never the sealed detail itself.
    for (const name of ["untrimmedLines", "sensitivePlaces", "serviceRouteId"]) {
      expect(await importErrors(use(name, "../domain/sanitize"), "src/ui/traceStore.ts")).toBe(1);
    }
  }, 30_000);

  it("let only the service code open a route reference", async () => {
    expect(await importErrors(use("serviceRouteId", "../domain/sanitize"), "src/service/loader.ts")).toBe(0);
    expect(await importErrors(use("serviceRouteId", "./sanitize"), "src/domain/trim.ts")).toBe(1);
    expect(await importErrors(use("serviceRouteId", "../domain/sanitize"), "src/ui/routesView.ts")).toBe(1);
    expect(await importErrors(use("serviceRouteId", "./domain/sanitize"), "src/main.ts")).toBe(1);
  }, 30_000);
});

describe("ways around the seals", () => {
  async function syntaxErrors(code: string, filePath: string): Promise<number> {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).filter((message) => message.ruleId === "no-restricted-syntax").length;
  }

  it("are closed: no dynamic import and no glob import anywhere in the web", async () => {
    for (const file of ["src/ui/mapView.ts", "src/main.ts", "src/domain/trim.ts", "src/service/loader.ts"]) {
      expect(await syntaxErrors('export const load = () => import("../domain/sanitize");\n', file)).toBe(1);
      expect(await syntaxErrors('export const all = import.meta.glob("../domain/sanit*.ts", { eager: true });\n', file)).toBe(1);
      expect(await syntaxErrors('export const all = import.meta.globEager("../domain/*.ts");\n', file)).toBe(1);
    }
    // Reading the address of the module itself is not a way around anything.
    expect(await syntaxErrors("export const here = import.meta.url;\n", "src/main.ts")).toBe(0);
  }, 30_000);
});

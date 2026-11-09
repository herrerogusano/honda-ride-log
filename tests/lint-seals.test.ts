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

  it("let only the service code open a route reference", async () => {
    expect(await importErrors(use("serviceRouteId", "../domain/sanitize"), "src/service/loader.ts")).toBe(0);
    expect(await importErrors(use("serviceRouteId", "./sanitize"), "src/domain/trim.ts")).toBe(1);
    expect(await importErrors(use("serviceRouteId", "../domain/sanitize"), "src/ui/routesView.ts")).toBe(1);
    expect(await importErrors(use("serviceRouteId", "./domain/sanitize"), "src/main.ts")).toBe(1);
  }, 30_000);
});

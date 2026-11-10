// Checks the two storage exceptions with the repository's own ESLint
// configuration: localStorage only in src/storage/maintenance.ts (phase 2),
// sessionStorage only in src/auth/pendingLogin.ts (phase 3), and each file
// still banned from the other's storage and from the HTML sinks. The
// maintenance file's own cases are in tests/units.test.ts.
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();

async function errorsIn(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "parse");
}

describe("browser storage rules", () => {
  it("lets the pending-login file use sessionStorage", async () => {
    expect(await errorsIn("src/auth/pendingLogin.ts", "export const s = sessionStorage;\nexport const t = window.sessionStorage;\n")).toEqual([]);
  });

  it.each(["src/auth/login.ts", "src/auth/session.ts", "src/service/mcpClient.ts", "src/main.ts", "src/storage/maintenance.ts", "src/ui/app.ts"])("bans sessionStorage in %s", async (file) => {
    expect(await errorsIn(file, "export const s = sessionStorage;\nexport const t = window.sessionStorage;\n")).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
    ]);
  });

  it.each(["src/main.ts", "src/service/mcpClient.ts", "src/auth/session.ts", "src/ui/app.ts", "src/storage/maintenance.ts", "vite.config.ts"])(
    "bans importing the pending-login helpers from %s",
    async (file) => {
      const code = 'import { browserSessionStorage } from "./auth/pendingLogin";\nexport const s = browserSessionStorage();\n';
      expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
      const relative = 'import { savePendingLogin } from "../auth/pendingLogin.ts";\nexport const s = savePendingLogin;\n';
      expect(await errorsIn(file, relative)).toEqual(["@typescript-eslint/no-restricted-imports"]);
      const query = 'import { savePendingLogin } from "../auth/pendingLogin.ts?v=1";\nexport const s = savePendingLogin;\n';
      expect(await errorsIn(file, query)).toEqual(["@typescript-eslint/no-restricted-imports"]);
    },
  );

  it("lets the sign-in flow import them", async () => {
    const code = 'import { browserSessionStorage } from "./pendingLogin";\nexport const s = browserSessionStorage();\n';
    expect(await errorsIn("src/auth/login.ts", code)).toEqual([]);
  });

  // Guards the lists in eslint.config.js against drifting apart: each
  // exception lifts its own storage and nothing else.
  async function banned(file: string, rule: string): Promise<string[]> {
    const config = (await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown[]> };
    return (config.rules[rule] ?? [])
      .slice(1)
      .map((entry) => {
        const { name, object, property } = entry as Record<string, string | undefined>;
        return `${object ?? ""}.${name ?? property ?? ""}`;
      })
      .sort();
  }

  it.each([
    ["src/auth/pendingLogin.ts", "sessionStorage"],
    ["src/storage/maintenance.ts", "localStorage"],
  ])("bans in %s everything banned elsewhere except %s", async (file, lifted) => {
    for (const rule of ["no-restricted-globals", "no-restricted-properties"]) {
      const elsewhere = await banned("src/auth/login.ts", rule);
      const here = await banned(file, rule);
      expect(elsewhere.some((entry) => entry.endsWith(".sessionStorage"))).toBe(true);
      expect(elsewhere.some((entry) => entry.endsWith(".localStorage"))).toBe(true);
      expect(here).toEqual(elsewhere.filter((entry) => !entry.endsWith(`.${lifted}`)));
    }
  });

  it("bans every storage and HTML sink in an ordinary file", async () => {
    for (const file of ["src/auth/login.ts", "src/ui/app.ts", "src/main.ts"]) {
      expect(await banned(file, "no-restricted-globals")).toEqual([".localStorage", ".sessionStorage"]);
      const properties = await banned(file, "no-restricted-properties");
      expect(properties).toEqual(expect.arrayContaining([".localStorage", ".sessionStorage", ".innerHTML", "document.write"]));
    }
  });

  it("still bans localStorage and HTML sinks in the pending-login file", async () => {
    const code = "export const a = localStorage;\nexport const b = window.localStorage;\ndocument.body.innerHTML = '';\n";
    expect(await errorsIn("src/auth/pendingLogin.ts", code)).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
      "no-restricted-properties",
    ]);
  });
});

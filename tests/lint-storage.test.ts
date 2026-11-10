// Checks the storage exception of phase 3 with the repository's own ESLint
// configuration: sessionStorage only in src/auth/pendingLogin.ts, localStorage
// and HTML sinks still banned there.
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

  it.each(["src/auth/login.ts", "src/auth/session.ts", "src/service/mcpClient.ts", "src/main.ts"])("bans sessionStorage in %s", async (file) => {
    expect(await errorsIn(file, "export const s = sessionStorage;\nexport const t = window.sessionStorage;\n")).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
    ]);
  });

  it.each(["src/main.ts", "src/service/mcpClient.ts", "src/auth/session.ts", "src/ui/app.ts", "vite.config.ts"])(
    "bans importing the pending-login helpers from %s",
    async (file) => {
      const code = 'import { browserSessionStorage } from "./auth/pendingLogin";\nexport const s = browserSessionStorage();\n';
      expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
      const relative = 'import { savePendingLogin } from "../auth/pendingLogin.ts";\nexport const s = savePendingLogin;\n';
      expect(await errorsIn(file, relative)).toEqual(["@typescript-eslint/no-restricted-imports"]);
    },
  );

  it("lets the sign-in flow import them", async () => {
    const code = 'import { browserSessionStorage } from "./pendingLogin";\nexport const s = browserSessionStorage();\n';
    expect(await errorsIn("src/auth/login.ts", code)).toEqual([]);
  });

  it("bans in the pending-login file everything banned elsewhere except sessionStorage", async () => {
    // Guards the repeated lists in eslint.config.js against drifting apart.
    const options = async (file: string, rule: string) => {
      const config = (await eslint.calculateConfigForFile(file)) as { rules: Record<string, unknown[]> };
      return (config.rules[rule] ?? []).slice(1).map((entry) => {
        const { name, object, property } = entry as Record<string, string | undefined>;
        return `${object ?? ""}.${name ?? property ?? ""}`;
      });
    };
    for (const rule of ["no-restricted-globals", "no-restricted-properties"]) {
      const elsewhere = await options("src/auth/login.ts", rule);
      const here = await options("src/auth/pendingLogin.ts", rule);
      expect(elsewhere.some((entry) => entry.endsWith(".sessionStorage"))).toBe(true);
      expect(here.sort()).toEqual(elsewhere.filter((entry) => !entry.endsWith(".sessionStorage")).sort());
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

// Checks the four storage exceptions with the repository's own ESLint
// configuration: localStorage only in src/storage/maintenance.ts (phase 2)
// and in src/storage/consent.ts (with document.cookie, docs/PLAN.md section
// 16), sessionStorage only in src/auth/pendingLogin.ts (phase 3) and in
// src/auth/savedSession.ts (the access token, docs/PLAN.md section 10), and each
// file still banned from the others' storage and from the HTML sinks. The
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

  it.each(["src/auth/login.ts", "src/auth/session.ts", "src/boot.ts", "src/service/mcpClient.ts", "src/main.ts", "src/storage/maintenance.ts", "src/ui/app.ts", "src/analytics/tracker.ts"])("bans sessionStorage in %s", async (file) => {
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

  it("lets the saved-session file use sessionStorage for the token, and nothing else", async () => {
    expect(await errorsIn("src/auth/savedSession.ts", "export const s = sessionStorage;\nexport const t = window.sessionStorage;\n")).toEqual([]);
    expect(await errorsIn("src/auth/savedSession.ts", "export const a = localStorage;\nexport const c = document.cookie;\ndocument.body.innerHTML = '';\n")).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
      "no-restricted-properties",
    ]);
  });

  it.each(["src/main.ts", "src/boot.ts", "src/auth/session.ts", "src/auth/pendingLogin.ts", "src/service/mcpClient.ts", "src/ui/app.ts", "src/analytics/tracker.ts", "src/storage/consent.ts", "vite.config.ts"])(
    "bans importing the stored token from %s",
    async (file) => {
      for (const from of ["./auth/savedSession", "../auth/savedSession.ts", "./savedSession.ts?raw", "./savedSession.ts#x", "./savedSession.ts?raw#x", "./savedSession#x"]) {
        const code = `import { readSavedSession } from "${from}";\nexport const r = readSavedSession;\n`;
        expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
      }
    },
  );

  it.each(["src/main.ts", "src/boot.ts", "src/ui/app.ts", "src/ui/summary.ts", "src/domain/sanitize.ts", "src/service/loader.ts", "src/ui/traceStore.ts", "src/analytics/tracker.ts"])(
    "bans reaching the kept account data from %s, with a query or a fragment too",
    async (file) => {
      for (const from of ["./auth/savedSession", "../auth/savedSession.ts", "./savedSession.ts?x", "./savedSession.ts#x", "./savedSession?x#x", "./savedSession#x"]) {
        const code = `import { readSavedAccount, saveAccount, clearSavedAccount } from "${from}";\nexport const r = [readSavedAccount, saveAccount, clearSavedAccount];\n`;
        expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
      }
    },
  );

  it("keeps the saved-session file away from the route id, the traces and their store, with a query or a fragment too", async () => {
    for (const suffix of ["", "?x", "#x"]) {
      const code =
        `import { serviceRouteId, untrimmedLines, sensitivePlaces } from "../domain/sanitize.ts${suffix}";\n` +
        `import { screenTrace } from "../domain/trim${suffix}";\n` +
        `import { createTraceStore } from "../ui/traceStore${suffix}";\n` +
        "export const x = [serviceRouteId, untrimmedLines, sensitivePlaces, screenTrace, createTraceStore];\n";
      // One error per sealed name: three from the sanitizer, the screen trace, the store.
      expect(await errorsIn("src/auth/savedSession.ts", code)).toEqual(Array(5).fill("no-restricted-imports"));
    }
  });

  it("lets only the sign-in flow import the stored token", async () => {
    const code = 'import { readSavedSession } from "./savedSession";\nexport const r = readSavedSession;\n';
    expect(await errorsIn("src/auth/login.ts", code)).toEqual([]);
  });

  it("keeps the saved-session file away from the pending login, the consent and the counters", async () => {
    const code =
      'import { savePendingLogin } from "./pendingLogin";\nimport { readConsent } from "../storage/consent";\nimport { createTracker } from "../analytics/tracker";\nexport const x = [savePendingLogin, readConsent, createTracker];\n';
    expect(await errorsIn("src/auth/savedSession.ts", code)).toEqual([
      "@typescript-eslint/no-restricted-imports",
      "@typescript-eslint/no-restricted-imports",
      "@typescript-eslint/no-restricted-imports",
    ]);
  });

  it.each([
    ["src/auth/pendingLogin.ts", ["sessionStorage"]],
    ["src/auth/savedSession.ts", ["sessionStorage"]],
    ["src/storage/maintenance.ts", ["localStorage"]],
    ["src/storage/consent.ts", ["localStorage", "cookie"]],
  ])("bans in %s everything banned elsewhere except %s", async (file, lifted) => {
    for (const rule of ["no-restricted-globals", "no-restricted-properties"]) {
      const elsewhere = await banned("src/auth/login.ts", rule);
      const here = await banned(file, rule);
      expect(elsewhere.some((entry) => entry.endsWith(".sessionStorage"))).toBe(true);
      expect(elsewhere.some((entry) => entry.endsWith(".localStorage"))).toBe(true);
      expect(here).toEqual(elsewhere.filter((entry) => !lifted.some((name) => entry.endsWith(`.${name}`))));
    }
  });

  it("lets only the consent file touch document.cookie", async () => {
    const code = "export const c = document.cookie;\n";
    expect(await errorsIn("src/storage/consent.ts", code)).toEqual([]);
    for (const file of ["src/storage/maintenance.ts", "src/auth/pendingLogin.ts", "src/analytics/tracker.ts", "src/ui/app.ts", "src/main.ts"]) {
      expect(await errorsIn(file, code)).toEqual(["no-restricted-properties"]);
    }
  });

  it("lets the consent file use localStorage and nothing else", async () => {
    expect(await errorsIn("src/storage/consent.ts", "export const a = localStorage;\nexport const b = window.localStorage;\n")).toEqual([]);
    expect(await errorsIn("src/storage/consent.ts", "export const s = sessionStorage;\ndocument.body.innerHTML = '';\n")).toEqual([
      "no-restricted-globals",
      "no-restricted-properties",
    ]);
  });

  it("lets only the counters import the consent file", async () => {
    const code = 'import { readConsent } from "../storage/consent";\nexport const r = readConsent;\n';
    expect(await errorsIn("src/analytics/tracker.ts", code)).toEqual([]);
    for (const file of ["src/ui/app.ts", "src/analytics/consentNotice.ts", "src/auth/login.ts", "src/main.ts", "src/boot.ts"]) {
      expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports"]);
    }
  });

  it("lets only the entry point start the third-party counters, so a sign-in document can stay free of them", async () => {
    const code =
      'import { createTracker } from "./analytics/tracker";\nimport { mountConsentNotice } from "./analytics/consentNotice.ts";\nexport const t = [createTracker, mountConsentNotice];\n';
    expect(await errorsIn("src/main.ts", code)).toEqual([]);
    for (const file of ["src/boot.ts", "src/auth/login.ts", "src/ui/app.ts", "src/ui/summary.ts", "src/service/mcpClient.ts"]) {
      expect(await errorsIn(file, code)).toEqual(["@typescript-eslint/no-restricted-imports", "@typescript-eslint/no-restricted-imports"]);
    }
    expect(await errorsIn("src/boot.ts", 'import type { Counter } from "./analytics/config";\nexport type C = Counter;\n')).toEqual([]);
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

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** GitHub Pages serves only this folder (docs/PLAN.md, section 17, "Dos publicaciones"). */
const FOLDER = new URL("../gh-pages-redirect/", import.meta.url);
const TARGET = "https://my-ride-log.pages.dev/";
const read = (name: string): string => readFileSync(new URL(name, FOLDER), "utf8");

describe("GitHub Pages redirect page", () => {
  it("holds only index.html and an identical 404.html", () => {
    expect(readdirSync(FOLDER).sort()).toEqual(["404.html", "index.html"]);
    expect(read("404.html")).toBe(read("index.html"));
  });

  it("has no scripts, no inline styles or handlers and no other origin", () => {
    const page = read("index.html");
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/<style/i);
    expect(page).not.toMatch(/\sstyle\s*=/i);
    expect(page).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page).not.toMatch(/javascript:/i);
    expect(page).not.toMatch(/<(img|iframe|link\s+rel="(?!canonical)|object|embed|form)/i);
    // Every absolute address on the page is the target, nothing else.
    expect(page.match(/https?:\/\/[^"\s<]+/g)).toEqual([TARGET, TARGET, TARGET]);
  });

  it("redirects at once to the root of the new address, dropping the query and the fragment", () => {
    const page = read("index.html");
    expect(page).toContain(`<meta http-equiv="refresh" content="0; url=${TARGET}">`);
    expect(page).toContain(`<link rel="canonical" href="${TARGET}">`);
    expect(page).toContain(`<a href="${TARGET}" rel="noreferrer">Ride Log se ha mudado a my-ride-log.pages.dev</a>`);
    expect(page).toContain('<html lang="es">');
  });

  it("carries a strict policy and sends no referrer", () => {
    const page = read("index.html");
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">`,
    );
    expect(page).not.toMatch(/script-src|unsafe/);
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("is what pages.yml publishes, without building the app", () => {
    const workflow = readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
    expect(workflow).toMatch(/path: gh-pages-redirect\n/);
    expect(workflow).not.toMatch(/npm |path: dist/);
    expect(workflow).toContain("!github.event.repository.private && github.ref == 'refs/heads/main'");
    for (const line of workflow.split("\n").filter((l) => /uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
  });
});

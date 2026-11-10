// Fails the build if the page Vite produced does not carry exactly the
// security policy of csp.config.json, or if it contains inline code. Runs
// after `vite build`.
//
// It is a net against our own mistakes (a plugin that injects a script, a
// loosened policy), written with regular expressions over the HTML that Vite
// emits. It is not an HTML parser and does not defend against someone who
// edits dist/ by hand: whoever can do that can also skip this script.
import { readdirSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const expected = JSON.parse(read("../csp.config.json"));
const problems = [];

// A build whose mode has a service configured in environments.config.json
// also connects to the origins of /mcp and of the login, and nothing else
// (docs/PLAN.md, section 10). Usage: node scripts/check-dist.mjs [mode].
const mode = process.argv[2] ?? "production";
const environments = JSON.parse(read("../environments.config.json"));
const entry = Object.hasOwn(environments, mode) ? environments[mode] : null;
// Trimmed like src/service/environment.ts, which already validated the entry during the build.
const value = (field) => (typeof entry?.[field] === "string" ? entry[field].trim() : "");
if (value("mcpUrl") || value("loginDomain") || value("webClientId")) {
  const origins = [new URL(value("mcpUrl")).origin, new URL(value("loginDomain")).origin];
  expected.directives["connect-src"] = [...expected.directives["connect-src"], ...new Set(origins)];
}
const html = read("../dist/index.html").replace(/<!--[\s\S]*?-->/g, "");
if (html.includes("<!--")) problems.push("unterminated or nested HTML comment");
if (!/<html[^>]*>\s*<head[^>]*>/i.test(html)) problems.push("something sits between <html> and <head>");
if (/<template\b/i.test(html)) problems.push("<template> element found");
for (const meta of html.matchAll(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?([^"'\s>]+)/gi)) {
  if (meta[1].toLowerCase() !== "content-security-policy") problems.push(`unexpected http-equiv: ${meta[1]}`);
}

const decode = (text) => text.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

function parsePolicy(content) {
  const directives = {};
  for (const part of content.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    if (name in directives) problems.push(`directive repeated: ${name}`);
    directives[name] = values;
  }
  return directives;
}

const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
const policies = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/gi)];
if (policies.length !== 1) {
  problems.push(`expected exactly one Content-Security-Policy meta tag, found ${policies.length}`);
} else {
  const actual = JSON.stringify(parsePolicy(decode(policies[0][1])));
  if (actual !== JSON.stringify(expected.directives)) {
    problems.push(`policy differs from csp.config.json: ${actual}`);
  }
  // The policy only governs what comes after it, so it must come first.
  if (!head.trimStart().startsWith(policies[0][0])) {
    problems.push("the Content-Security-Policy meta tag is not the first element of <head>");
  }
}

const referrers = [...html.matchAll(/<meta name="referrer" content="([^"]*)"/gi)].map((match) => match[1]);
if (referrers.length !== 1 || referrers[0] !== expected.referrer) {
  problems.push(`expected one referrer policy "${expected.referrer}", found ${JSON.stringify(referrers)}`);
}

for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
  if (!/(?:^|\s)src\s*=/i.test(tag[1])) problems.push("inline <script> found");
}
if (/<style[\s>]/i.test(html)) problems.push("inline <style> found");
if (/<[^>]*\son[a-z]+\s*=/i.test(html)) problems.push("inline event handler found");
if (/<[^>]*\sstyle\s*=/i.test(html)) problems.push("inline style attribute found");
if (/<[^>]*\sreferrerpolicy\s*=/i.test(html)) problems.push("per-element referrer policy found");
if (/<(iframe|object|embed|base)\b/i.test(html)) problems.push("frame, plugin or base element found");
for (const url of html.matchAll(/\s(?:src|href|srcset|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
  const value = (url[1] ?? url[2] ?? url[3] ?? "").trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) problems.push(`resource from another origin: ${value}`);
}

// Fonts come from this site only (font-src 'self', docs/PLAN.md D-025): the
// stylesheets must not point anywhere else, and the font files must be there.
const assets = readdirSync(new URL("../dist/assets/", import.meta.url));
const fonts = assets.filter((name) => name.endsWith(".woff2"));
if (fonts.length === 0) problems.push("no .woff2 font in dist/assets");
for (const name of assets.filter((one) => one.endsWith(".css"))) {
  const sheet = read(`../dist/assets/${name}`);
  for (const url of sheet.matchAll(/url\(\s*["']?([^"')]*)/gi)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url[1].trim()) && !/^data:image\/svg\+xml/i.test(url[1].trim())) {
      problems.push(`stylesheet ${name} loads from another origin: ${url[1].slice(0, 60)}`);
    }
  }
  if (/@import/i.test(sheet)) problems.push(`stylesheet ${name} has an @import`);
}

if (problems.length > 0) {
  console.error("dist/index.html failed the publication checks:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("dist/index.html: exact security policy present, no inline code, no foreign resources.");

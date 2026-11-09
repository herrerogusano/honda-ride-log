// Fails the build if the published page does not carry exactly the security
// policy of csp.config.json, or if it contains inline code. Runs after
// `vite build`.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const expected = JSON.parse(read("../csp.config.json"));
// Comments cannot hide or fake anything: drop them before looking.
const html = read("../dist/index.html").replace(/<!--[\s\S]*?-->/g, "");
const problems = [];

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
if (/<(iframe|object|embed|base)\b/i.test(html)) problems.push("frame, plugin or base element found");
for (const url of html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/gi)) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url[1])) problems.push(`resource from another origin: ${url[1]}`);
}

if (problems.length > 0) {
  console.error("dist/index.html failed the publication checks:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("dist/index.html: exact security policy present, no inline code, no foreign resources.");

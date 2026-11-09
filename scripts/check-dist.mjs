// Fails the build if the published page lost its security policy or gained
// inline code. Runs after `vite build`.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const problems = [];

const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
if (!csp) {
  problems.push("missing Content-Security-Policy meta tag");
} else {
  const policy = csp[1].replaceAll("&#39;", "'");
  for (const needed of ["default-src 'none'", "script-src 'self'", "base-uri 'none'"]) {
    if (!policy.includes(needed)) problems.push(`policy lacks: ${needed}`);
  }
  for (const banned of ["'unsafe-inline'", "'unsafe-eval'", " * ", "http:"]) {
    if (` ${policy} `.includes(banned)) problems.push(`policy contains: ${banned.trim()}`);
  }
}
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push("inline <script> found");
if (/<style[\s>]/i.test(html)) problems.push("inline <style> found");
if (/\son[a-z]+\s*=/i.test(html)) problems.push("inline event handler found");
if (/\sstyle\s*=/i.test(html)) problems.push("inline style attribute found");

if (problems.length > 0) {
  console.error("dist/index.html failed the publication checks:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("dist/index.html: security policy present, no inline code.");

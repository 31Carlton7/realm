// Checks that every file and symbol the architecture docs cite still exists.
//
//   node docs/architecture/check-citations.mjs
//
// A citation is a code span holding a repo path, optionally with `:Symbol` or `:Class.member`
// (`apps/server/src/rpc/server.ts:RpcServer.broadcast`). On a bullet line, a bare identifier after a
// citation (`, \`deliver\``) is read as another symbol in that same file. A path must exist and every
// dotted part of a symbol must appear in the file as a whole word. Under a heading that names the
// mobile app, paths are read from the `feat/mobile` branch, where that code lives.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const MOBILE_REF = "origin/feat/mobile";

// A path starts at a top-level entry of the repo (or of the mobile branch, which adds `services/`).
const TOP = new Set([...readdirSync(root), "services"]);
const isPath = (s) => /^[\w.@/-]+$/.test(s) && TOP.has(s.split("/")[0]) && (s.includes("/") || s.includes("."));
const IDENT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function fromBranch(path) {
  try { return execFileSync("git", ["-C", root, "show", `${MOBILE_REF}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 }); }
  catch { return null; }
}
function branchHasDir(path) {
  try { return execFileSync("git", ["-C", root, "ls-tree", "--name-only", MOBILE_REF, path.replace(/\/$/, "")], { encoding: "utf8" }).trim() !== ""; }
  catch { return false; }
}
function read(path, mobile) {
  if (mobile) return fromBranch(path);
  const abs = join(root, path);
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
}
const hasWord = (text, word) => new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

let checked = 0;
const problems = [];
for (const name of readdirSync(here).filter((f) => f.endsWith(".md")).sort()) {
  const lines = readFileSync(join(here, name), "utf8").split("\n");
  let mobile = false;
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) { fenced = !fenced; return; }
    if (fenced) return;
    if (/^#{1,6} /.test(line)) mobile = /mobile/i.test(line);
    const bullet = /^\s*- /.test(line);
    let lastFile = null;
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      const where = `${name}:${i + 1}`;
      const [path, symbol] = span.includes(":") && !span.includes("://") ? span.split(/:(.*)/s) : [span, undefined];
      if (isPath(path)) {
        checked++;
        if (path.endsWith("/")) {
          const ok = mobile ? branchHasDir(path) : existsSync(join(root, path));
          if (!ok) problems.push(`${where}  missing folder ${path}`);
          lastFile = null;
          continue;
        }
        if (!mobile && /(^|\/)(dist|out)\//.test(path)) { lastFile = null; continue; } // a build output, not in git
        if (!mobile && existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()) { lastFile = null; continue; }
        const text = read(path, mobile);
        if (text === null) { problems.push(`${where}  missing file ${path}${mobile ? ` (on ${MOBILE_REF})` : ""}`); lastFile = null; continue; }
        lastFile = { path, text };
        if (symbol !== undefined) {
          if (!IDENT.test(symbol)) { problems.push(`${where}  unreadable symbol ${span}`); continue; }
          for (const part of symbol.split(".")) if (!hasWord(text, part)) problems.push(`${where}  ${path} has no ${part}`);
        }
      } else if (bullet && lastFile && IDENT.test(span)) {
        checked++;
        for (const part of span.split(".")) if (!hasWord(lastFile.text, part)) problems.push(`${where}  ${lastFile.path} has no ${part}`);
      }
    }
  });
}

for (const p of problems) console.error(p);
console.log(`${checked - problems.length}/${checked} citations hold`);
process.exit(problems.length ? 1 : 0);

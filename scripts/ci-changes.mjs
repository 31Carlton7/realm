#!/usr/bin/env node
/**
 * Whether a pull request changes anything the Build desktop workflow builds or tests
 * (.github/workflows/build-desktop.yml). A path counts unless it is listed in IGNORED, so a new folder
 * runs the whole pipeline until someone decides it shouldn't.
 *
 *   BASE=<sha> HEAD=<sha> node scripts/ci-changes.mjs
 *
 * prints the changed files and writes `desktop=true|false` to $GITHUB_OUTPUT. Without BASE (a push to
 * main, a run by hand) the answer is always true.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Read by nothing the workflow runs: the website, the docs, and the repo's own prose. CHANGELOG.md is
 *  not here: the app's What's New is tested against it. */
export const IGNORED = [
  /^site\//,
  /^docs\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^(README|CONTRIBUTING|AGENTS|CLAUDE|design)\.md$/,
];

/** An empty list is a diff that could not be read, not a change to nothing, so it runs everything. */
export function touchesDesktop(files) {
  return files.length === 0 || files.some((f) => !IGNORED.some((re) => re.test(f)));
}

function main() {
  const { BASE, HEAD = "HEAD", GITHUB_OUTPUT } = process.env;
  let desktop = true;
  if (BASE) {
    const files = execFileSync("git", ["diff", "--name-only", `${BASE}...${HEAD}`], { encoding: "utf8" }).split("\n").filter(Boolean);
    console.log(files.join("\n"));
    desktop = touchesDesktop(files);
  }
  console.log(`desktop=${desktop}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `desktop=${desktop}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

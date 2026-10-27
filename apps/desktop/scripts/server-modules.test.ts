// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { hoistModules } from "./lib/hoist-modules.mjs";
import { unresolvedModules } from "./lib/unresolved-modules.mjs";

type Pkg = { deps?: string[]; peers?: string[]; optional?: string[] };
// v2.5.0's server in small: the MCP SDK, whose pkce-challenge only pnpm's .pnpm can see, two versions
// of content-type, a peer, and the Agent SDK with its Windows `claude` installed and its Linux one not.
const PACKAGES: Record<string, Pkg> = {
  "@modelcontextprotocol/sdk@1.30.0": { deps: ["pkce-challenge@5.0.0", "content-type@1.0.5", "body-parser@2.2.0"], peers: ["zod@3.25.76"] },
  "pkce-challenge@5.0.0": {},
  "content-type@1.0.5": {},
  "content-type@2.1.0": {},
  "body-parser@2.2.0": { deps: ["content-type@2.1.0"] },
  "zod@3.25.76": {},
  "@anthropic-ai/claude-agent-sdk@0.3.281": { optional: ["@anthropic-ai/claude-agent-sdk-win32-x64@0.3.281", "@anthropic-ai/claude-agent-sdk-linux-x64@0.3.281"] },
  "@anthropic-ai/claude-agent-sdk-win32-x64@0.3.281": {},
};
const SERVER_DEPS = ["@modelcontextprotocol/sdk@1.30.0", "@anthropic-ai/claude-agent-sdk@0.3.281", "zod@3.25.76"];
const nameOf = (id: string) => id.slice(0, id.lastIndexOf("@"));
const versionOf = (id: string) => id.slice(id.lastIndexOf("@") + 1);

/** `pnpm deploy`'s layout: each package real in .pnpm/<id>/node_modules/<name>, with what it imports
 *  linked beside it, and the server's own dependencies linked at the top. Each package's index.js
 *  reports the version of everything it imported, so a run prints the tree Node actually resolved. */
function pnpmLayout(): string {
  const server = join(tempDir("server-modules-"), "server");
  const home = (id: string) => join(server, "node_modules", ".pnpm", id.replaceAll("/", "+"), "node_modules");
  const real = (id: string) => join(home(id), nameOf(id));
  const link = (target: string, at: string) => { mkdirSync(dirname(at), { recursive: true }); symlinkSync(target, at, "junction"); };
  for (const [id, { deps = [], peers = [], optional = [] }] of Object.entries(PACKAGES)) {
    const imports = [...deps, ...peers];
    const range = (ids: string[]) => Object.fromEntries(ids.map((d) => [nameOf(d), `^${versionOf(d)}`]));
    mkdirSync(real(id), { recursive: true });
    writeFileSync(join(real(id), "package.json"), JSON.stringify({ name: nameOf(id), version: versionOf(id), type: "module", main: "index.js",
      dependencies: range(deps), peerDependencies: range(peers), optionalDependencies: range(optional) }));
    writeFileSync(join(real(id), "index.js"), [
      ...imports.map((d, i) => `import * as d${i} from "${nameOf(d)}";`),
      ...optional.map((d, i) => `const o${i} = await import("${nameOf(d)}").then((m) => m.tree, () => "missing");`),
      `export const tree = { version: "${versionOf(id)}", ${[...imports.map((d, i) => `"${nameOf(d)}": d${i}.tree`), ...optional.map((d, i) => `"${nameOf(d)}": o${i}`)].join(", ")} };`,
    ].join("\n"));
    for (const d of [...imports, ...optional].filter((d) => d in PACKAGES)) link(real(d), join(home(id), nameOf(d)));
  }
  for (const d of SERVER_DEPS) link(real(d), join(server, "node_modules", nameOf(d)));
  writeFileSync(join(server, "package.json"), JSON.stringify({ name: "@realm/server", type: "module", dependencies: Object.fromEntries(SERVER_DEPS.map((d) => [nameOf(d), `^${versionOf(d)}`])) }));
  mkdirSync(join(server, "dist"));
  writeFileSync(join(server, "dist", "main.js"), [
    ...SERVER_DEPS.map((d, i) => `import * as s${i} from "${nameOf(d)}";`),
    `console.log(JSON.stringify({ ${SERVER_DEPS.map((d, i) => `"${nameOf(d)}": s${i}.tree`).join(", ")} }));`,
  ].join("\n"));
  return server;
}

/** What NSIS's 7-Zip puts in the installer: every link followed, and a copy where it was. (By hand:
 *  Node's cpSync keeps a link below the top as a link even with `dereference`.) */
const followLinks = (from: string, to: string): void => {
  if (!statSync(from).isDirectory()) return copyFileSync(from, to);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) followLinks(join(from, name), join(to, name));
};
const asInstalled = (server: string): string => {
  const copy = join(tempDir("server-installed-"), "server");
  followLinks(server, copy);
  return copy;
};
const run = (server: string) => spawnSync(process.execPath, [join(server, "dist", "main.js")], { encoding: "utf8" });
const links = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return lstatSync(path).isSymbolicLink() ? [path] : lstatSync(path).isDirectory() ? links(path) : [];
});

const RESOLVED = {
  "@modelcontextprotocol/sdk": { version: "1.30.0", "pkce-challenge": { version: "5.0.0" }, "content-type": { version: "1.0.5" },
    "body-parser": { version: "2.2.0", "content-type": { version: "2.1.0" } }, zod: { version: "3.25.76" } },
  "@anthropic-ai/claude-agent-sdk": { version: "0.3.281", "@anthropic-ai/claude-agent-sdk-win32-x64": { version: "0.3.281" }, "@anthropic-ai/claude-agent-sdk-linux-x64": "missing" },
  zod: { version: "3.25.76" },
};

describe("the staged server's node_modules", () => {
  it("in pnpm's layout, runs where it was staged and not once 7-Zip has followed its links", () => {
    const server = pnpmLayout();
    expect(JSON.parse(run(server).stdout)).toEqual(RESOLVED);
    const installed = run(asInstalled(server));
    expect(installed.status).not.toBe(0);
    expect(installed.stderr).toContain("Cannot find package 'pkce-challenge'");
  });

  it("unresolvedModules names what the installed copy cannot import, and passes pnpm's layout where links may stay", () => {
    const server = pnpmLayout();
    expect(unresolvedModules(server, { links: true })).toEqual({ packages: 8, problems: [] });
    const linked = unresolvedModules(server, { links: false }).problems;
    expect(linked).toHaveLength(links(server).length);
    expect(linked.every((p) => p.endsWith(" is a link"))).toBe(true);

    const problems = unresolvedModules(asInstalled(server), { links: false }).problems;
    expect(problems).toContain(`${join("node_modules", "@modelcontextprotocol", "sdk")} cannot find pkce-challenge`);
    // Installed, so missed: the Agent SDK would have no `claude` to spawn. Not installed is another platform's.
    expect(problems).toContain(`${join("node_modules", "@anthropic-ai", "claude-agent-sdk")} cannot find @anthropic-ai/claude-agent-sdk-win32-x64`);
    expect(problems.join("\n")).not.toContain("linux-x64");

    symlinkSync(tempDir("outside-"), join(server, "node_modules", ".pnpm", "outside"), "junction");
    expect(unresolvedModules(server, { links: true }).problems).toEqual([`${join("node_modules", ".pnpm", "outside")} links outside the server`]);
  });

  it("hoistModules rebuilds it as real directories that resolve every import to the version pnpm did", () => {
    const server = pnpmLayout();
    expect(hoistModules(join(server, "node_modules"))).toEqual({ packages: 8, nested: 1 });
    expect(links(server)).toEqual([]);
    expect(existsSync(join(server, "node_modules", ".pnpm"))).toBe(false);
    expect(unresolvedModules(server, { links: false }).problems).toEqual([]);
    const version = (...path: string[]) => JSON.parse(readFileSync(join(server, "node_modules", ...path, "package.json"), "utf8")).version;
    expect(version("content-type")).toBe("1.0.5");
    expect(version("body-parser", "node_modules", "content-type")).toBe("2.1.0");
    expect(JSON.parse(run(asInstalled(server)).stdout)).toEqual(RESOLVED);
  });
});

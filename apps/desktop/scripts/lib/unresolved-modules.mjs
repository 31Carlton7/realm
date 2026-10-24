/**
 * What a staged server could not import once it is packaged. From the server's own dependencies on,
 * every package's are looked up the way Node looks them up — from the package's real directory, in its
 * node_modules and then in each one above it — and never above the server: a packaged app has nothing
 * installed above it, and on the machine that builds it what is above it is the workspace's. An optional
 * dependency or a peer counts as missing only when it is installed somewhere in the tree; one that is
 * not belongs to another platform.
 *
 * With `links: false`, for Windows, a link is itself a problem (hoist-modules.mjs says why), so the tree
 * has to resolve as real directories. Elsewhere a link can stay as long as it lands inside the tree.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export function unresolvedModules(server, { links }) {
  const root = realpathSync(server);
  const inTree = (path) => { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); };
  const problems = [];

  const installed = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!links) problems.push(`${relative(root, path)} is a link`);
        else if (!existsSync(path)) problems.push(`${relative(root, path)} is a broken link`);
        else if (!inTree(realpathSync(path))) problems.push(`${relative(root, path)} links outside the server`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const parent = basename(dir);
      if (existsSync(join(path, "package.json"))) {
        if (parent === "node_modules") installed.add(entry.name);
        else if (parent.startsWith("@") && basename(dirname(dir)) === "node_modules") installed.add(`${parent}/${entry.name}`);
      }
      walk(path);
    }
  };
  walk(root);

  const find = (from, name) => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (basename(dir) !== "node_modules" && existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      if (dir === root || dirname(dir) === dir) return null;
    }
  };
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const optional = new Set([...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    const who = relative(root, dir) || "the server";
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...optional])) {
      const found = find(dir, name);
      if (found === null) {
        if (!optional.has(name) || installed.has(name)) problems.push(`${who} cannot find ${name}`);
      } else if (!inTree(found)) {
        problems.push(`${who} finds ${name} outside the server, at ${found}`);
      } else if (!seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return { packages: seen.size - 1, problems };
}

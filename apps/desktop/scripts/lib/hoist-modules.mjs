/**
 * Rebuilds a staged server's node_modules for Windows: from pnpm's layout, where a package reaches its
 * dependencies through links into node_modules/.pnpm, to npm's flat one, where every package is a real
 * directory sitting where Node looks for it.
 *
 * A Windows package cannot carry links. pnpm makes them junctions, which hold absolute paths:
 * electron-builder copies them into win-unpacked still pointing at this machine's .pack-stage, and
 * NSIS's 7-Zip follows them, so the installer holds a copy of the package at every link. A copy at the
 * top of node_modules cannot see what pnpm kept beside the real one in .pnpm, and v2.5.0's installed
 * server stopped at its first import: "Cannot find package 'pkce-challenge'", from the MCP SDK. The
 * copies were also two thirds of the installer.
 *
 * The packages are the ones pnpm resolved from the lockfile. `pnpm deploy --config.node-linker=hoisted`
 * makes this shape too, but resolves every version again without the lockfile.
 */
import { cpSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The packages a node_modules directory holds, a scoped one as "@scope/name". pnpm's own entries
 *  (.pnpm, .bin, .modules.yaml) start with a dot. */
const packageNames = (modules) => readdirSync(modules).filter((name) => !name.startsWith("."))
  .flatMap((name) => name.startsWith("@") ? readdirSync(join(modules, name)).map((sub) => `${name}/${sub}`) : [name]);

export function hoistModules(modules) {
  // A package's real directory is .pnpm/<id>/node_modules/<name>, and pnpm links what it depends on
  // beside it: its dependencies and peers, each by the name it imports it by.
  const linked = new Map();
  const dependenciesOf = (real) => {
    if (!linked.has(real)) {
      const scoped = basename(dirname(real)).startsWith("@");
      const own = scoped ? dirname(dirname(real)) : dirname(real);
      const self = scoped ? `${basename(dirname(real))}/${basename(real)}` : basename(real);
      linked.set(real, new Map(packageNames(own).filter((name) => name !== self).sort().map((name) => [name, realpathSync(join(own, name))])));
    }
    return linked.get(real);
  };

  // Where each package goes, as "/node_modules/a/node_modules/b", and the real directory it comes from.
  const plan = new Map();
  const queue = [];
  const place = (at, real) => { plan.set(at, real); queue.push(at); };
  // Where Node finds `name` from the package at `at`: in its own node_modules, then in each one above.
  const lookup = (at, name) => {
    for (let dir = at; ; dir = dir.slice(0, dir.lastIndexOf("/node_modules/"))) {
      if (plan.has(`${dir}/node_modules/${name}`)) return `${dir}/node_modules/${name}`;
      if (!dir) return null;
    }
  };
  for (const name of packageNames(modules).sort()) place(`/node_modules/${name}`, realpathSync(join(modules, name)));
  // Breadth first: every dependency of a package is placed before any of theirs is, so nesting one
  // under a package can never hide a version that something below it has already found.
  while (queue.length) {
    const at = queue.shift();
    for (const [name, real] of dependenciesOf(plan.get(at))) {
      const found = lookup(at, name);
      if (found === null) place(`/node_modules/${name}`, real);
      else if (plan.get(found) !== real) place(`${at}/node_modules/${name}`, real);
    }
  }
  for (const [at, real] of plan) {
    for (const [name, dependency] of dependenciesOf(real)) {
      if (plan.get(lookup(at, name)) !== dependency) throw new Error(`[hoist-modules] ${at.slice(1)} would not find the ${name} pnpm resolved for it`);
    }
  }

  // Copied, not moved: a junction's absolute path stops resolving once anything it points through moves.
  const flat = `${modules}.flat`;
  rmSync(flat, { recursive: true, force: true });
  // A package's own node_modules/.bin is pnpm's, holding its dependencies' commands for install scripts.
  const notBin = (path) => !(basename(path) === ".bin" && basename(dirname(path)) === "node_modules");
  for (const [at, real] of plan) cpSync(real, join(flat, ...at.split("/").slice(2)), { recursive: true, filter: notBin });
  rmSync(modules, { recursive: true, force: true });
  renameSync(flat, modules);
  return { packages: plan.size, nested: [...plan.keys()].filter((at) => at.lastIndexOf("/node_modules/") > 0).length };
}

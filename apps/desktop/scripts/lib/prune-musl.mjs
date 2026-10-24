/**
 * Drops the musl builds from a staged server's `node_modules/.pnpm`, for a Linux package.
 *
 * An AppImage or a deb runs only on a glibc Linux (Electron needs glibc), but pnpm installs the musl
 * build of every native package beside the glibc one, because the lockfile records no libc: the Agent
 * SDK's musl `claude` alone is 230 MB nobody can run, and the SDK takes the glibc build first wherever
 * glibc is. The links pnpm made to the dropped packages go too, so none is left dangling.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function pruneMusl(pnpmDir) {
  const dropped = readdirSync(pnpmDir).filter((pkg) => /-musl@/.test(pkg));
  for (const pkg of dropped) rmSync(join(pnpmDir, pkg), { recursive: true, force: true });
  for (const modules of [join(pnpmDir, "node_modules"), ...readdirSync(pnpmDir).map((pkg) => join(pnpmDir, pkg, "node_modules"))]) {
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      const entries = name.startsWith("@") ? readdirSync(join(modules, name)).map((n) => join(modules, name, n)) : [join(modules, name)];
      for (const entry of entries) if (lstatSync(entry).isSymbolicLink() && !existsSync(entry)) rmSync(entry);
    }
  }
  return dropped;
}

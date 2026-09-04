// Assembles apps/desktop/.pack-stage/ — everything electron-builder ships as extraResources — plus
// build/icon.icns. Run by `pnpm dist` / `pnpm dist:dir` (see electron-builder.yml). Assumes the root
// `pnpm build` already ran (server dist exists); fails loudly when it hasn't.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const root = join(desktop, "..", "..");
const stage = join(desktop, ".pack-stage");

if (!existsSync(join(root, "apps", "server", "dist", "main.js"))) {
  console.error("[stage-pack] apps/server/dist/main.js missing — run `pnpm build` first (or use `pnpm dist` at the root)");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. realm-server, deployable: dist + resolved production node_modules (node-pty prebuilds, agent
// SDKs — the tsup externals). `--legacy` because this workspace doesn't use injected dependencies.
console.log("[stage-pack] pnpm deploy @realm/server…");
execFileSync("pnpm", ["--filter", "@realm/server", "deploy", "--legacy", "--prod", join(stage, "server")], { cwd: root, stdio: "inherit" });

// pnpm's legacy deploy leaves an aggregator link for the package being deployed. In the workspace
// it points back to apps/server, which is outside the staged tree; after electron-builder copies it
// into Realm.app the same relative link is dangling, and macOS codesign rejects the app. Runtime
// starts dist/main.js directly, so this self-reference is neither imported nor needed.
rmSync(join(stage, "server", "node_modules", ".pnpm", "node_modules", "@realm", "server"), { force: true });

// Deploy copies the whole package dir; only dist/, node_modules/ and package.json matter at runtime.
for (const f of ["src", "scripts", "tsconfig.json", "tsup.config.ts", "vitest.config.ts"]) {
  rmSync(join(stage, "server", f), { recursive: true, force: true });
}
// node-pty ships prebuilds for every platform; a mac .app only ever loads darwin ones.
const pnpmDir = join(stage, "server", "node_modules", ".pnpm");
if (existsSync(pnpmDir)) {
  for (const pkg of readdirSync(pnpmDir)) {
    const prebuilds = join(pnpmDir, pkg, "node_modules", "node-pty", "prebuilds");
    if (!existsSync(prebuilds)) continue;
    for (const plat of readdirSync(prebuilds)) {
      if (!plat.startsWith("darwin-")) rmSync(join(prebuilds, plat), { recursive: true, force: true });
    }
  }
}

// 2. Bundled skills — bundledSkillsDir()'s packaged branch reads <resources>/skills.
cpSync(join(root, "skills"), join(stage, "skills"), { recursive: true });

// 3. Swift helpers (each optional: absent when swiftc was unavailable, and each degrades on its own).
for (const [binary, missing] of [
  ["scrollphase", "the app falls back to timer-based scroll phases"],
  ["axhelper", "the computer-use tools stay unavailable"],
]) {
  const built = join(desktop, "native", "bin", binary);
  if (existsSync(built)) cpSync(built, join(stage, binary));
  else console.warn(`[stage-pack] native/bin/${binary} not built; ${missing}`);
}

// 4. App icon where electron-builder's mac.icon points.
mkdirSync(join(desktop, "build"), { recursive: true });
cpSync(join(root, "resources", "icon.icns"), join(desktop, "build", "icon.icns"));

console.log("[stage-pack] staged:", stage);

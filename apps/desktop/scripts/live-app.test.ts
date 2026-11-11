import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every script here that boots Electron starts it through lib/live-app.mjs (or, for a script that is
 * its own Electron main, lib/quiet-electron.cjs), so it runs quietly and is reaped. A live check that
 * spawned the binary itself put a window in front of the owner, took the keyboard and bounced the
 * Dock — which is what this exists to stop coming back. See README.md.
 */
const dir = import.meta.dirname;
const scripts = readdirSync(dir).filter((f) => /\.(mjs|cjs)$/.test(f));
const source = (f: string) => readFileSync(join(dir, f), "utf8");
/** Comments say how to run a check (`electron apps/desktop/scripts/x.cjs`); code is what launches. */
const code = (f: string) => source(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ELECTRON_BINARY = /Electron\.app\/Contents\/MacOS\/Electron|node_modules\/\.bin\/electron|electron\/dist\//;
/** A boot of the built app: its main, or its server under Electron's own Node. */
const BOOTS_APP = /out\/main\/index\.js|LIVE_MAIN|ELECTRON_RUN_AS_NODE/;
const USES_HELPER = /from "\.\/lib\/live-app\.mjs"/;

/** The site's capture scripts boot the same built app from their own folder. */
const siteDir = join(dir, "../../../site/scripts");
const siteScripts = readdirSync(siteDir).filter((f) => f.endsWith(".mjs"));
const siteCode = (f: string) => readFileSync(join(siteDir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("live scripts start Electron through lib/live-app.mjs", () => {
  it("finds the scripts it guards", () => {
    expect(scripts.filter((f) => f.endsWith("-live.mjs")).length).toBeGreaterThan(100);
  });

  it("no script names the Electron binary itself", () => {
    expect(scripts.filter((f) => ELECTRON_BINARY.test(code(f)))).toEqual([]);
  });

  it("every script that boots the app imports the helper", () => {
    expect(scripts.filter((f) => f.endsWith(".mjs") && BOOTS_APP.test(code(f)) && !USES_HELPER.test(code(f)))).toEqual([]);
  });

  it("the site's capture scripts do the same", () => {
    expect(siteScripts.filter((f) => ELECTRON_BINARY.test(siteCode(f)))).toEqual([]);
    const boots = siteScripts.filter((f) => /out\/main\/index\.js/.test(siteCode(f)));
    expect(boots).toContain("capture-product.mjs");
    expect(boots.filter((f) => !/from "\.\.\/\.\.\/apps\/desktop\/scripts\/lib\/live-app\.mjs"/.test(siteCode(f)))).toEqual([]);
  });

  it("the helper is imported with the script's own imports, not inside a string it writes out", () => {
    const late = scripts.filter((f) => {
      const lines = source(f).split("\n");
      const at = lines.findIndex((l) => USES_HELPER.test(l));
      return at !== -1 && lines.slice(0, at).some((l) => /^(const|let|function|async function|class) /.test(l));
    });
    expect(late).toEqual([]);
  });

  it("every live script that is its own Electron main is quiet, or says why it must be seen", () => {
    const own = scripts.filter((f) => f.endsWith("-live.cjs"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((f) => !/require\("\.\/lib\/quiet-electron\.cjs"\)/.test(code(f)) && !/live-app: visible — \S/.test(source(f)))).toEqual([]);
  });

  it("a check seen on screen gives its reason", () => {
    const bare = scripts.filter((f) => /\bvisible:\s*(true|""|''|1)\b/.test(code(f)));
    expect(bare).toEqual([]);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { probeGraphify } from "./probe";

/**
 * A real executable standing in for graphify, spawned for real — the ACP probe test's discipline
 * (`process.execPath` + `-e`) reached through a script file instead, because `probeGraphify` owns its
 * `--version` argv and takes no args parameter to smuggle a `-e` through.
 */
let dir: string;
const stub = (name: string, body: string): string => {
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

let printsVersion: string;
let printsTwoLines: string;
let printsNothing: string;
let brokenExit: string;
beforeAll(() => {
  dir = tempDir("realm-graphify-probe-");
  printsVersion = stub("graphify-ok", `console.log("graphify 0.9.53");`);
  printsTwoLines = stub("graphify-chatty", `console.log("graphify 0.9.53\\nextra diagnostic line");`);
  printsNothing = stub("graphify-mute", `console.log("");`);
  // What a graphify installed WITHOUT the [mcp] extra looks like: the binary is on PATH, it starts,
  // and it dies — `ModuleNotFoundError: No module named 'mcp'`.
  brokenExit = stub("graphify-broken", `console.error("ModuleNotFoundError: No module named 'mcp'"); process.exit(1);`);
});

describe("probeGraphify", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    // The named mutant swallows the spawn error into `available: true`, which would show an
    // "installed" card to a user who has never run `uv tool install`.
    const r = await probeGraphify("/definitely/not/a/binary");
    expect(r).toMatchObject({ available: false, version: null });
    expect(r.reason).toBeTruthy();
  });

  it("reports unavailable when the binary exists but exits non-zero", async () => {
    // Separate from the missing-binary case because they fail differently: ENOENT never runs, this
    // one runs and refuses. The named mutant treats ONLY ENOENT as unavailable, so a graphify
    // installed without the [mcp] extra would read as healthy.
    const r = await probeGraphify(brokenExit);
    expect(r).toMatchObject({ available: false, version: null });
    expect(r.reason).toBeTruthy();
  });

  it("reports available and takes the version from stdout", async () => {
    const r = await probeGraphify(printsVersion);
    expect(r).toEqual({ available: true, version: "graphify 0.9.53", reason: null });
  });

  it("takes only the first line of multi-line --version output", async () => {
    // The named mutant keeps the whole trimmed stdout, gluing a diagnostic line into the version.
    expect((await probeGraphify(printsTwoLines)).version).toBe("graphify 0.9.53");
  });

  it("coerces empty --version output to a null version, never an empty string", async () => {
    // The named mutant drops the `|| null` and yields `""` — a falsy value that renders as a
    // version-shaped hole instead of as "available, version unknown".
    const r = await probeGraphify(printsNothing);
    expect(r.available).toBe(true);
    expect(r.version).toBeNull();
  });

  it("reads the binary from REALM_GRAPHIFY_BIN when no bin is passed", async () => {
    // The named mutant hardcodes "graphify", so the override every other probe honours does nothing
    // and a uv install in ~/.local/bin (off PATH for the app's environment) is invisible.
    const before = process.env.REALM_GRAPHIFY_BIN;
    process.env.REALM_GRAPHIFY_BIN = printsVersion;
    try { expect((await probeGraphify()).version).toBe("graphify 0.9.53"); }
    finally { if (before === undefined) delete process.env.REALM_GRAPHIFY_BIN; else process.env.REALM_GRAPHIFY_BIN = before; }
  });
});

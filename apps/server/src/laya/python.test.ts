import { describe, expect, it } from "vitest";
import { findPython, pythonCandidates, type PythonSearchDeps } from "./python";

/**
 * Finding an interpreter, over a fake filesystem and interpreters that answer the probe as told.
 * What must die: an x86_64 or Rosetta Python accepted, a version outside 3.10–3.14 accepted, the
 * Command Line Tools' shim ever run, 3.14 preferred over a measured version, and a guess where the
 * honest answer is "none".
 */

type Fake = { version?: [number, number, number]; machine?: string; fails?: NodeJS.ErrnoException };

function mac(files: Record<string, Fake>, o: { env?: NodeJS.ProcessEnv; links?: Record<string, string>; dirs?: Record<string, string[]> } = {}) {
  const ran: { file: string; args: string[] }[] = [];
  const deps: PythonSearchDeps = {
    env: o.env ?? { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    home: "/Users/u",
    exists: (p) => p in files || p in (o.links ?? {}),
    list: (d) => o.dirs?.[d] ?? [],
    realpath: (p) => o.links?.[p] ?? p,
    exec: async (file, args) => {
      ran.push({ file, args });
      const f = files[o.links?.[file] ?? file] ?? files[file];
      if (!f) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      if (f.fails) throw f.fails;
      return { stdout: JSON.stringify({ version: f.version, machine: f.machine ?? "arm64" }) + "\n" };
    },
  };
  return { deps, ran };
}

describe("finding a Python for Laya", () => {
  it("takes 3.13 over every other version it finds", async () => {
    const { deps } = mac({
      "/opt/homebrew/bin/python3.12": { version: [3, 12, 8] },
      "/opt/homebrew/bin/python3.13": { version: [3, 13, 12] },
      "/opt/homebrew/bin/python3.11": { version: [3, 11, 14] },
    });
    expect((await findPython(deps)).found).toEqual({ path: "/opt/homebrew/bin/python3.13", version: "3.13.12" });
  });

  it("admits 3.14 only when nothing measured is there — a 3.14 found first loses to a 3.12 found later", async () => {
    // `python3` on the PATH is Homebrew's 3.14 and is asked before pyenv's 3.12.
    const both = mac({
      "/opt/homebrew/bin/python3": { version: [3, 14, 6] },
      "/Users/u/.pyenv/versions/3.12.1/bin/python3": { version: [3, 12, 1] },
    }, { dirs: { "/Users/u/.pyenv/versions": ["3.12.1"] } });
    expect((await findPython(both.deps)).found?.version).toBe("3.12.1");
    const only = mac({ "/opt/homebrew/bin/python3": { version: [3, 14, 6] } });
    expect((await findPython(only.deps)).found).toEqual({ path: "/opt/homebrew/bin/python3", version: "3.14.6" });
  });

  it("turns down an interpreter running under Rosetta, and says that is why", async () => {
    const { deps } = mac({ "/usr/local/bin/python3.12": { version: [3, 12, 8], machine: "x86_64" } });
    const found = await findPython(deps);
    expect(found.found).toBeNull();
    expect(found.rejected).toEqual([{ path: "/usr/local/bin/python3.12", why: expect.stringMatching(/x86_64.*Rosetta.*arm64/) }]);
  });

  it("turns down versions outside 3.10 to 3.14", async () => {
    const { deps } = mac({
      "/opt/homebrew/bin/python3": { version: [3, 9, 6] },
      "/usr/local/bin/python3": { version: [3, 15, 0] },
    });
    const found = await findPython(deps);
    expect(found.found).toBeNull();
    expect(found.rejected.map((r) => r.why)).toEqual(["Python 3.9.6; Laya needs 3.10 to 3.14", "Python 3.15.0; Laya needs 3.10 to 3.14"]);
  });

  it("names an Intel-only binary on a Mac without Rosetta, instead of Node's 'Unknown system error -86'", async () => {
    const ebadarch = Object.assign(new Error("spawn Unknown system error -86"), { errno: -86 });
    const { deps } = mac({ "/usr/local/bin/python3.12": { fails: ebadarch } });
    expect((await findPython(deps)).rejected).toEqual([{ path: "/usr/local/bin/python3.12", why: "does not run here (an Intel build, and this Mac has no Rosetta to run it)" }]);
  });

  it("never runs anything in /usr/bin, which is the developer tools' 3.9 and on a bare Mac their install dialog", async () => {
    const { deps, ran } = mac({ "/usr/bin/python3": { version: [3, 9, 6] }, "/opt/homebrew/bin/python3.13": { version: [3, 13, 12] } });
    await findPython(deps);
    expect(ran.map((r) => r.file)).not.toContain("/usr/bin/python3");
    expect(pythonCandidates(deps)).not.toContain("/usr/bin/python3");
  });

  it("never runs a link into /usr/bin either", async () => {
    const { deps, ran } = mac({ "/usr/bin/python3": { version: [3, 9, 6] } }, { links: { "/opt/homebrew/bin/python3": "/usr/bin/python3" } });
    expect((await findPython(deps)).found).toBeNull();
    expect(ran).toEqual([]);
  });

  it("asks one binary once, however many names it has", async () => {
    const { deps, ran } = mac(
      { "/opt/homebrew/Cellar/python@3.13/bin/python3.13": { version: [3, 13, 12] } },
      { links: { "/opt/homebrew/bin/python3.13": "/opt/homebrew/Cellar/python@3.13/bin/python3.13", "/opt/homebrew/bin/python3": "/opt/homebrew/Cellar/python@3.13/bin/python3.13" } },
    );
    await findPython(deps);
    expect(ran).toHaveLength(1);
  });

  it("looks where pyenv and uv keep interpreters off the PATH", async () => {
    const { deps } = mac(
      { "/Users/u/.local/share/uv/python/cpython-3.11.16-macos-aarch64-none/bin/python3": { version: [3, 11, 16] } },
      { env: { PATH: "/bin" }, dirs: { "/Users/u/.local/share/uv/python": ["cpython-3.11.16-macos-aarch64-none"] } },
    );
    expect((await findPython(deps)).found?.version).toBe("3.11.16");
  });

  it("REALM_LAYA_PYTHON names the one interpreter to consider", async () => {
    const { deps, ran } = mac({
      "/opt/homebrew/bin/python3.13": { version: [3, 13, 12] },
      "/tmp/py/bin/python3": { version: [3, 12, 3] },
    }, { env: { PATH: "/opt/homebrew/bin", REALM_LAYA_PYTHON: "/tmp/py/bin/python3" } });
    expect((await findPython(deps)).found).toEqual({ path: "/tmp/py/bin/python3", version: "3.12.3" });
    expect(ran.map((r) => r.file)).toEqual(["/tmp/py/bin/python3"]);
  });

  it("answers none, not a guess, on a Mac with no Python at all", async () => {
    const { deps, ran } = mac({});
    expect(await findPython(deps)).toEqual({ found: null, rejected: [] });
    expect(ran).toEqual([]);
  });
});

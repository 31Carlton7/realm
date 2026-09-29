import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Which Python on this Mac can host Laya — found by asking each interpreter, never guessed.
 *
 * The rules, and what each rests on (measured 2026-09-29):
 *
 *  - **arm64 only.** PyTorch 2.14 publishes macOS wheels for arm64 and nothing else, and MPS — the
 *    GPU path the design's 35 ms was measured on — exists only on Apple silicon. An interpreter that
 *    reports `x86_64` is running under Rosetta and is turned down; on a Mac without Rosetta the same
 *    binary does not start at all ("Bad CPU type in executable"), which is a refusal too.
 *  - **3.10 to 3.14, and 3.13 first.** `laya` 0.3.21 declares `Requires-Python >=3.10`, and 3.13 is
 *    what the design was measured on. 3.14 was checked by resolving `laya[serve]==0.3.21` with
 *    `--only-binary=:all:` in a pip-only 3.14 venv: every dependency arrives as an arm64 wheel, at the
 *    versions the working 3.13 install has (torch 2.14.0 cp314, numpy 2.5.3, tokenizers 0.23.2). It
 *    was not RUN — that takes a second PyTorch install — so it comes last: a Mac with 3.13 or older
 *    gets that, and a Mac whose only Python is Homebrew's current `python3` is not told it has none.
 *  - **Never `/usr/bin`.** Its `python3` is the Command Line Tools' 3.9, under the floor on every
 *    macOS this runs on — and on a Mac without the tools, running it opens their install dialog.
 *
 * `REALM_LAYA_PYTHON` names the one interpreter to consider, for a developer whose Python lives
 * somewhere this search does not look.
 */

/** In order of preference. */
export const LAYA_PYTHON_VERSIONS = ["3.13", "3.12", "3.11", "3.10", "3.14"] as const;

export type PythonChoice = { path: string; version: string };
export type PythonSearch = {
  found: PythonChoice | null;
  /** Interpreters that exist here and were turned down, each with the reason in a clause. */
  rejected: { path: string; why: string }[];
};

/** What the interpreter says about itself. `-I -S` keeps PYTHON* variables, the user site and every
 *  `.pth` file out of it, so the answer is the interpreter's and not the environment's. */
const PROBE = "import json, platform, sys; print(json.dumps({'version': list(sys.version_info[:3]), 'machine': platform.machine()}))";

export type PythonSearchDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  list?: (dir: string) => string[];
  realpath?: (path: string) => string;
  /** Runs `file` with `args`; a test answers for the interpreter instead. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
};

/** Where a Mac keeps Pythons: Homebrew (Apple silicon, then Intel), the python.org installer, the
 *  PATH main merged from the login shell, then pyenv and uv, which keep theirs off the PATH. */
export function pythonCandidates(d: PythonSearchDeps = {}): string[] {
  const env = d.env ?? process.env;
  const exists = d.exists ?? existsSync;
  const list = d.list ?? ((dir: string) => { try { return readdirSync(dir); } catch { return []; } });
  const pinned = env.REALM_LAYA_PYTHON?.trim();
  if (pinned) return exists(pinned) ? [pinned] : [];
  const home = d.home ?? homedir();
  const out: string[] = [];
  for (const v of LAYA_PYTHON_VERSIONS) {
    out.push(`/opt/homebrew/bin/python${v}`, `/Library/Frameworks/Python.framework/Versions/${v}/bin/python${v}`, `/usr/local/bin/python${v}`);
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === "/usr/bin") continue;
    for (const name of [...LAYA_PYTHON_VERSIONS.map((v) => `python${v}`), "python3"]) out.push(join(dir, name));
  }
  for (const root of [join(home, ".pyenv", "versions"), join(home, ".local", "share", "uv", "python")]) {
    for (const entry of list(root).sort().reverse()) out.push(join(root, entry, "bin", "python3"));
  }
  return [...new Set(out)].filter((p) => exists(p));
}

/**
 * Ask every candidate, then pick by the preference above. All of them are asked rather than stopping
 * at the first that passes, because a `python3` on the PATH says nothing about its version until it
 * is run, and a 3.14 found early must not beat a 3.12 found late.
 */
export async function findPython(d: PythonSearchDeps = {}): Promise<PythonSearch> {
  const realpath = d.realpath ?? ((p: string) => { try { return realpathSync(p); } catch { return p; } });
  const exec = d.exec ?? ((file: string, args: string[]) => new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (e, stdout) => (e ? reject(e) : resolve({ stdout })));
  }));
  const seen = new Set<string>();
  const accepted: (PythonChoice & { rank: number })[] = [];
  const rejected: PythonSearch["rejected"] = [];
  for (const path of pythonCandidates(d)) {
    // Homebrew's python3.13 and its python3 are one binary; asking it twice would list it twice.
    const real = realpath(path);
    if (seen.has(real) || real.startsWith("/usr/bin/")) continue;
    seen.add(real);
    let said: { version: number[]; machine: string };
    try {
      said = JSON.parse((await exec(path, ["-I", "-S", "-c", PROBE])).stdout.trim()) as typeof said;
    } catch (e) {
      rejected.push({ path, why: `does not run here (${firstLine(e)})` });
      continue;
    }
    const version = said.version.join(".");
    const minor = `${said.version[0]}.${said.version[1]}`;
    const rank = (LAYA_PYTHON_VERSIONS as readonly string[]).indexOf(minor);
    if (said.machine !== "arm64") rejected.push({ path, why: `Python ${version} for ${said.machine}, which runs under Rosetta; PyTorch needs a native arm64 build` });
    else if (rank === -1) rejected.push({ path, why: `Python ${version}; Laya needs 3.10 to 3.14` });
    else accepted.push({ path, version, rank });
  }
  accepted.sort((a, b) => a.rank - b.rank);
  const best = accepted[0];
  return { found: best ? { path: best.path, version: best.version } : null, rejected };
}

function firstLine(e: unknown): string {
  // EBADARCH, which spawn throws for an Intel-only binary on a Mac without Rosetta. Node has no name
  // for it and says "Unknown system error -86", which tells nobody anything.
  if ((e as NodeJS.ErrnoException | null)?.errno === -86) return "an Intel build, and this Mac has no Rosetta to run it";
  const msg = e instanceof Error ? ((e as Error & { stderr?: string }).stderr?.trim() || e.message) : String(e);
  return msg.split("\n")[0]!.slice(0, 160);
}

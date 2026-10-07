import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AGENT_EXECUTABLE_CONFIG,
  AGENT_STATE_DIRS,
  CREDENTIAL_DIRS,
  TOOLCHAIN_CACHE_DIRS,
  type ExecutionSandboxPolicy,
  type ExecutionSandboxPrefs,
} from "@realm/contracts";
import { sandboxPathProblem } from "./profile";

/**
 * A user's choice plus this Mac's layout → the resolved policy the compiler takes.
 *
 * Split out from the service so it can be tested against a scratch home with no database, no
 * settings store and no spawning. The only I/O it does is `realpath`, and that is injectable.
 *
 * ## Why realpath is not optional here
 *
 * Seatbelt matches the path the KERNEL resolved. `/tmp` is a symlink to `/private/tmp` on macOS, and
 * `$TMPDIR` is under `/var/folders/...`, itself a symlink into `/private/var`. A writable root that
 * skips this step matches nothing, which fails closed and merely looks like a broken sandbox. A
 * PROTECTED root that skips it matches nothing too — and that fails OPEN, leaving `~/.ssh` readable
 * while the UI says it is not. That asymmetry is why protected roots below are emitted BOTH resolved
 * and literal: two rules where one might do, because the cost of the resolved one being wrong is a
 * leaked private key and the cost of the extra rule is a line of profile text.
 */

/** `path → its real path`, or null when nothing along it exists. Injectable so a test can describe a
 *  symlink layout without creating one. */
export type RootResolver = (path: string) => string | null;

/**
 * The real path of `p`, or — when `p` does not exist yet — the real path of the deepest ancestor that
 * does, with the missing tail appended.
 *
 * A cache directory that has never been used is the normal case, not an edge case: `~/.npm` does not
 * exist until the first `npm install`, and dropping it because it is absent would mean the first
 * install inside a sandbox fails at `mkdir`. Walking up gives the path npm is about to create, which
 * is the path the kernel will match.
 */
export const realRoot: RootResolver = (path) => {
  // Guarded rather than walked: `dirname("relative")` is `"."`, which resolves to the process's cwd,
  // so walking up a relative path would quietly answer with a root nobody asked for.
  if (!path.startsWith("/")) return null;
  let head = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return null; // walked off the top without resolving anything
      // `basename`, not `head.slice(parent.length + 1)`: for a child of `/` the parent is one
      // character long and the arithmetic eats the first letter of the name.
      tail.push(basename(head));
      head = parent;
    }
  }
};

/**
 * Writable roots that would make the policy a formality. Dropped rather than compiled, and the drop
 * goes through `onDrop` so it is never silent.
 *
 * Dropped, not refused. A space whose checkout is `/Users` gets a sandbox it cannot write its own
 * repo in, which is confusing and SAFE; refusing to start instead would mean every absent toolchain
 * cache — `~/.cargo` on a machine with no Rust — also had to be a refusal, since both arrive here as
 * the same kind of unusable root. Erring towards too-tight is the only direction this may err in.
 *
 * The home directory itself is deliberately NOT on this list. A space folder at `~` is a legitimate
 * (if unwise) thing to have, the protected roots still bite inside it, and refusing to start would
 * break a real user's real setup to enforce a preference.
 */
const DANGEROUS_WRITABLE_ROOTS: ReadonlySet<string> = new Set([
  "/", "/Applications", "/Library", "/System", "/Users", "/Volumes", "/bin", "/etc", "/opt",
  "/private", "/sbin", "/usr", "/var",
  // The RESOLVED forms of the four above that are symlinks on macOS. The check runs after realpath,
  // so `/var` arrives here as `/private/var` and would otherwise sail through the list that names it.
  // `/private/tmp` is deliberately absent: it is the resolved form of `/tmp`, which this posture
  // hands out on purpose, and it is world-writable on a stock macOS already.
  "/private/var", "/private/etc", "/System/Volumes/Data", "/System/Volumes/Data/Users",
]);

export type ResolveInput = {
  prefs: ExecutionSandboxPrefs;
  /** Every checkout the space owns — `EnvironmentsStore.list(spaceId).map(e => e.path)`. All of them
   *  rather than just the session's own, because an agent in a worktree routinely reads and writes
   *  its siblings (a `git worktree list`, a shared `node_modules`, a checkpoint). */
  checkouts: readonly string[];
  /** `os.homedir()`. */
  home: string;
  /** `os.tmpdir()` — the per-user `/var/folders/...` one, not `/tmp`. */
  tmpDir: string;
  /** `realmHome()`. Its database is protected; the rest of it (the skills plugin stage, which Claude
   *  loads from disk) has to stay readable, so this is NOT protected wholesale. */
  realmHome: string;
  /** Anything else the caller knows a process needs — a session's own scratch directory, say. */
  extraWritableRoots?: readonly string[];
  resolve?: RootResolver;
  /** Called for every root that could not be used, with the reason. Nothing is dropped silently. */
  onDrop?: (root: string, why: string) => void;
};

export function resolveExecutionSandboxPolicy(o: ResolveInput): ExecutionSandboxPolicy {
  const resolve = o.resolve ?? realRoot;
  const drop = o.onDrop ?? (() => {});

  const protectedRoots = protectedPaths(o, resolve);

  if (o.prefs.posture === "off") {
    // Still a full policy object, so `describeExecutionSandbox` and the UI have something to show.
    // Nothing is compiled from it — `sandboxCommand` branches on the posture before the compiler.
    return { posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: o.prefs.network };
  }

  const candidates: string[] = [];
  if (o.prefs.posture === "workspace-write") {
    candidates.push(...o.checkouts);
    candidates.push(...o.extraWritableRoots ?? []);
    // The agent CLIs' own state. Without these, `claude` and `codex` cannot write a transcript and
    // do not start — see AGENT_STATE_DIRS for what that costs and what is clawed back below.
    for (const rel of AGENT_STATE_DIRS) candidates.push(join(o.home, rel));
    for (const rel of TOOLCHAIN_CACHE_DIRS) candidates.push(join(o.home, rel));
    // `/tmp` as well as `$TMPDIR`: enough shell scripts hardcode `/tmp/foo` that leaving it out
    // produces failures nobody attributes to the sandbox. It resolves to `/private/tmp`, which is
    // world-writable already — allowing it gives away nothing that was not already shared.
    candidates.push(o.tmpDir, "/tmp");
  } else {
    // read-only: the process's own temp directory and nothing else. Not `/tmp` — a read-only session
    // has no build to stage, and the point of the posture is that it leaves no trace anywhere a
    // later command would look.
    candidates.push(o.tmpDir);
  }

  const writableRoots: string[] = [];
  for (const candidate of candidates) {
    const real = resolve(candidate);
    if (real === null) { drop(candidate, "nothing along this path exists"); continue; }
    if (DANGEROUS_WRITABLE_ROOTS.has(real)) { drop(candidate, `resolves to ${real}, which would grant most of the disk`); continue; }
    const problem = sandboxPathProblem(real);
    if (problem) { drop(candidate, `resolves to ${real}, which ${problem}`); continue; }
    writableRoots.push(real);
  }

  return {
    posture: o.prefs.posture,
    writableRoots: [...new Set(writableRoots)].sort(),
    // Realm ships no deny-by-default read posture; see the field's note in the contract for the cost
    // of adding one. Empty here means "everything readable except the protected list".
    readableRoots: [],
    readOnlyPaths: executableConfigPaths(o, resolve),
    protectedRoots,
    network: o.prefs.network,
  };
}

/**
 * The executable configuration a toolchain reads every run and must not be able to rewrite.
 *
 * Emitted for BOTH postures. Under `read-only` nothing in `$HOME` is writable anyway and these rules
 * are redundant — kept because redundancy is the cheap direction here, and because a future posture
 * that widens the writable set inherits the protection rather than quietly losing it.
 */
function executableConfigPaths(o: ResolveInput, resolve: RootResolver): string[] {
  const out = new Set<string>();
  const homes = [o.home, resolve(o.home)].filter((h): h is string => h !== null);
  for (const home of homes) {
    for (const rel of AGENT_EXECUTABLE_CONFIG) {
      const p = join(home, rel);
      if (sandboxPathProblem(p) === null) out.add(p);
      // The resolved form too, for `protectedPaths`' reason: a rule that misses fails OPEN. The cost
      // is that someone who symlinks `~/.claude/settings.json` into a dotfiles repo finds that one
      // file frozen while the rest of the repo stays editable — comprehensible, and the tight
      // direction, which is the only direction this may err in.
      const real = resolve(p);
      if (real !== null && real !== p && sandboxPathProblem(real) === null) out.add(real);
    }
  }
  return [...out].sort();
}

/**
 * The paths no posture may read or write: the user's credential directories, and Realm's own
 * database.
 *
 * The database is named file by file (`realm.db`, `-wal`, `-shm`) rather than by protecting the whole
 * of `realmHome`, because Claude sessions load Realm's skills plugin from a stage directory in that
 * same home — protecting the lot would silently turn skills off for every sandboxed session. SBPL's
 * `subpath` matches a regular file, and does not bleed to a sibling with the same prefix (verified:
 * protecting `realm.db` leaves `realm.db-wal` readable, which is why all three are listed).
 *
 * What is NOT protected, said plainly: the sealed values in that database are AES-GCM blobs whose key
 * lives in the macOS Keychain, and the Keychain is protected here too — but `~/.npmrc`, `~/.gitconfig`
 * and the shell rc files are readable, and any of them can hold a token.
 */
function protectedPaths(o: ResolveInput, resolve: RootResolver): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    if (sandboxPathProblem(p) === null) out.add(p);
    const real = resolve(p);
    // Both forms, always. See the header: a protected root that resolves to nothing fails OPEN, and
    // this is the one list where being over-broad costs nothing.
    if (real !== null && real !== p && sandboxPathProblem(real) === null) out.add(real);
  };
  // Both the home Realm was told about and the home the kernel would resolve it to, because the
  // entries are built by joining onto it: a `$HOME` that is itself under a symlink (a temp dir, an
  // account on an external volume) would otherwise produce protected paths that match nothing.
  const homes = [o.home, resolve(o.home)].filter((h): h is string => h !== null);
  const realmHomes = [o.realmHome, resolve(o.realmHome)].filter((h): h is string => h !== null);
  for (const home of homes) for (const rel of CREDENTIAL_DIRS) add(join(home, rel));
  for (const rh of realmHomes) for (const name of ["realm.db", "realm.db-wal", "realm.db-shm"]) add(join(rh, name));
  return [...out].sort();
}

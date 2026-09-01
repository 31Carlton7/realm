import { basename, dirname, resolve } from "node:path";
import type { Environment, ImportMatch, Profile, Project, Space } from "@realm/contracts";

/** Everything the matcher is allowed to see. Passed in rather than reached for, so the rules can be
 *  tested against a handful of literals instead of a database. */
export type MatchWorld = {
  spaces: Space[];
  environments: Environment[];
  projects: Project[];
  profiles: Profile[];
};

/**
 * How far above the recorded cwd the walk looks: the directory itself, then its immediate parent.
 *
 * The bound is the whole reason this matcher is trustworthy, and it was put here by evidence. This
 * machine has a `Project` row registering `~/Desktop/Home` — an ancestor of essentially every piece
 * of work on the disk — to one space. Unbounded, that single row is an ancestor of 255 of 290
 * candidates and captures all of them: a year of Stora, Versed, school and personal transcripts, all
 * confidently filed under one project because of one over-broad registration nobody remembers making.
 *
 * Two levels is what a real containment claim looks like: a session in `repo/packages/app` belongs to
 * `repo`. A directory five levels up is not describing this session's work, it is describing a tree
 * that happens to contain it — and everything else too. Anything deeper than the bound falls to the
 * profile catch-all, which is a visible, correctable outcome rather than a confident wrong one.
 */
export const MATCH_MAX_HOPS = 1;

/** Case- and punctuation-insensitive comparison key. "CSCI 360", "csci-360" and "csci_360" are the
 *  same workspace named three ways, and a matcher that missed that would send a whole course's
 *  sessions to the catch-all. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The cwd and its ancestors, deepest first, capped at `MATCH_MAX_HOPS` above the cwd. */
function walk(path: string): string[] {
  const out: string[] = [];
  let dir = resolve(path);
  for (let hop = 0; hop <= MATCH_MAX_HOPS; hop++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Which space a session or memory folder recorded at `cwd` belongs to.
 *
 * **Most specific location wins.** The walk goes deepest-first, and at each directory it asks the
 * four questions in strength order — is there an environment here, a project root, a space folder, a
 * space named after this directory. The first yes anywhere in the walk is the answer, so a precise
 * signal one level down always beats a vaguer one further up. Ordering the RULES without ordering the
 * PATHS is what produced the failure documented on `MATCH_MAX_HOPS`: rule 2 fired on a directory five
 * levels up before rule 4 ever got to look at the cwd's own name.
 *
 * Ties are refused, not broken. Two spaces registering the same directory, or two spaces whose names
 * normalise the same, produce no answer at that step and the walk continues: a coin flip between two
 * workspaces is how a year of someone's Versed history ends up in Stora.
 *
 * Every result carries its evidence, so a match the user disagrees with can be seen to be wrong
 * rather than merely disliked — and re-pointed in the preview before anything is written.
 */
export function matchSpace(cwd: string, world: MatchWorld): ImportMatch {
  if (!cwd) return fallbackProfile("", world);
  const live = new Set(world.spaces.map((s) => s.id));

  for (const dir of walk(cwd)) {
    // 1. An environment row at this directory. The strongest evidence there is: Realm has itself run
    //    work here for that space.
    const env = uniqueBy(world.environments.filter((e) => live.has(e.spaceId)), (e) => resolve(e.path) === dir);
    if (env) return { spaceId: env.spaceId, fallbackProfileId: null, reason: "environment", evidence: env.path };

    // 2. A registered project root.
    const proj = uniqueBy(world.projects.filter((p) => live.has(p.spaceId)), (p) => resolve(p.rootPath) === dir);
    if (proj) return { spaceId: proj.spaceId, fallbackProfileId: null, reason: "project", evidence: `project "${proj.name}" at ${proj.rootPath}` };

    // 3. The space's own folder under Realm's home.
    const folder = uniqueBy(world.spaces, (s) => resolve(s.folderPath) === dir);
    if (folder) return { spaceId: folder.id, fallbackProfileId: null, reason: "space-folder", evidence: folder.folderPath };

    // 4. The directory is named after a space. `<name>-worktrees` counts as naming `<name>`: git
    //    worktree checkouts conventionally sit in a sibling directory of that shape, and the branch
    //    checkouts under it are the same project by any honest reading.
    const name = basename(dir), key = norm(name);
    if (key) {
      const hit = uniqueBy(world.spaces, (s) => key === norm(s.name) || key === `${norm(s.name)}worktrees`);
      if (hit) return { spaceId: hit.id, fallbackProfileId: null, reason: "basename", evidence: `directory "${name}"` };
    }
  }
  return fallbackProfile(cwd, world);
}

/**
 * The profile a homeless candidate falls to — its catch-all space is created on `apply`, never on
 * scan.
 *
 * A path segment naming a profile is the signal (`…/Desktop/Home/School/SP26-EE-451` → School), and
 * unlike the space rules above this one reads the WHOLE path: a profile is a broad category, so a
 * broad match is the right shape for it, and being wrong costs a row in the wrong catch-all rather
 * than a transcript filed under a specific workspace it has nothing to do with.
 *
 * With no such segment the FIRST profile by sort order takes it. The user asked for unmatched
 * sessions to land somewhere general rather than be dropped, and "the profile at the top of your
 * sidebar" is at least a stated rule. Evidence says which of the two happened.
 */
function fallbackProfile(path: string, world: MatchWorld): ImportMatch {
  if (world.profiles.length === 0) return { spaceId: null, fallbackProfileId: null, reason: "none", evidence: null };
  for (let dir = resolve(path); path !== ""; dir = dirname(dir)) {
    const key = norm(basename(dir));
    const hit = key ? uniqueBy(world.profiles, (p) => norm(p.name) === key) : null;
    if (hit) return { spaceId: null, fallbackProfileId: hit.id, reason: "fallback", evidence: `directory "${basename(dir)}" names the ${hit.name} profile` };
    if (dirname(dir) === dir) break;
  }
  const first = [...world.profiles].sort((a, b) => a.sortOrder - b.sortOrder)[0]!;
  return { spaceId: null, fallbackProfileId: first.id, reason: "fallback", evidence: `no path evidence; defaulted to the ${first.name} profile` };
}

/** The one match, or null when zero or several match — the tie refusal, in one place so every rule
 *  refuses ties the same way. Several rows naming the SAME space is not a tie (two environments of
 *  one space cannot disagree about which space they are), so identity is compared, not row count. */
function uniqueBy<T extends { spaceId?: string; id?: string }>(items: T[], pred: (t: T) => boolean): T | null {
  const hits = items.filter(pred);
  if (hits.length === 0) return null;
  const spaces = new Set(hits.map((h) => h.spaceId ?? h.id));
  return spaces.size === 1 ? hits[0]! : null;
}

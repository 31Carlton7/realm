/**
 * Live check for the CLI import (`ImportService`): scans this machine's real `~/.claude`, `~/.codex`
 * and `~/.cursor` and prints what an import would do — without importing anything.
 *
 * Safe by construction on both sides of the read/write line:
 *
 * - The agent directories are opened read-only, which is the service's own posture, not this
 *   script's concession.
 * - The Realm database is a **copy**. `REALM_HOME` points at a scratch directory and the real
 *   `~/Realm/realm.db` is duplicated into it with `VACUUM INTO` (never `cp`: the live database is
 *   WAL, and a bare copy of the main file loses whatever is still in the log). So the matcher reasons
 *   over the user's actual spaces and profiles — which is the whole point of a preview — while every
 *   write this process could make lands in the scratch copy.
 *
 * Usage: `pnpm --filter @realm/server exec tsx scripts/live-import-check.ts [--all]`
 * `--all` includes the rows the default filter hides (scratch directories, Realm's own transcripts,
 * and anything already imported), so the filter itself can be inspected rather than trusted.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database";
import { EnvironmentsStore } from "../src/store/environments";
import { ItemsStore } from "../src/store/items";
import { ProfilesStore } from "../src/store/profiles";
import { ProjectsStore } from "../src/store/projects";
import { SessionEventsStore, SessionsStore } from "../src/store/sessions";
import { SettingsStore } from "../src/store/settings";
import { SpacesStore } from "../src/store/spaces";
import { MemoryService } from "../src/memory/service";
import { ImportService } from "../src/import/service";
import type { RpcServer } from "../src/rpc/server";

const all = process.argv.includes("--all");

const realDb = join(homedir(), "Realm", "realm.db");
if (!existsSync(realDb)) { console.error(`no Realm database at ${realDb}`); process.exit(1); }

const home = mkdtempSync(join(tmpdir(), "realm-import-check-"));
const copy = join(home, "realm.db");
// VACUUM INTO, never a file copy: `~/Realm/realm.db` is WAL, and the checkpointed pages that make
// the database current may still be sitting in `-wal`.
{
  const src = new DatabaseSync(`file:${realDb}?mode=ro`, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  src.close();
}

const db = openDatabase(copy);
const spaces = new SpacesStore(db, home);
const profiles = new ProfilesStore(db);
const settings = new SettingsStore(db);
const environments = new EnvironmentsStore(db);
const memory = new MemoryService({ home, settings, environments, scopes: { profileIdOf: (id) => spaces.get(id)?.profileId ?? null } });
const rpc = { broadcast: () => {} } as unknown as RpcServer;
const imports = new ImportService({
  home, db, rpc, spaces, profiles, projects: new ProjectsStore(db), environments,
  sessions: new SessionsStore(db), events: new SessionEventsStore(db), items: new ItemsStore(db), settings, memory,
});

const t0 = Date.now();
const scan = imports.scan();
const ms = Date.now() - t0;

const spaceName = new Map(spaces.listAll().map((s) => [s.id, s.name]));
const profileName = new Map(profiles.list().map((p) => [p.id, p.name]));
const target = (m: { spaceId: string | null; fallbackProfileId: string | null }) =>
  m.spaceId ? spaceName.get(m.spaceId) ?? m.spaceId : m.fallbackProfileId ? `${profileName.get(m.fallbackProfileId) ?? m.fallbackProfileId} › Imported` : "—";

console.log(`scanned in ${(ms / 1000).toFixed(1)}s  ·  scratch home ${home}\n`);
for (const s of scan.sources) {
  console.log(`${s.source.padEnd(7)} ${s.available ? "" : "(not installed) "}${s.sessions} sessions, ${s.unreadable} unreadable  ${s.root}`);
}

const keep = scan.sessions.filter((s) => all || (!s.scratch && !s.fromRealm && !s.imported && !s.duplicate));
console.log(`\nsessions: ${scan.sessions.length} found, ${keep.length} would import`);
const hidden = { scratch: 0, fromRealm: 0, imported: 0, duplicate: 0 };
for (const s of scan.sessions) { if (s.scratch) hidden.scratch++; else if (s.fromRealm) hidden.fromRealm++; else if (s.duplicate) hidden.duplicate++; else if (s.imported) hidden.imported++; }
console.log(`  hidden: ${hidden.scratch} scratch, ${hidden.fromRealm} Realm's own, ${hidden.duplicate} older copies of a resumed thread, ${hidden.imported} already imported`);

const byTarget = new Map<string, { n: number; msgs: number; reasons: Set<string> }>();
for (const s of keep) {
  const k = target(s.match);
  const e = byTarget.get(k) ?? { n: 0, msgs: 0, reasons: new Set<string>() };
  e.n++; e.msgs += s.messages; e.reasons.add(s.match.reason);
  byTarget.set(k, e);
}
console.log("\n  by destination:");
for (const [k, v] of [...byTarget].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`    ${String(v.n).padStart(4)} sessions ${String(v.msgs).padStart(6)} msgs  ${k.padEnd(24)} via ${[...v.reasons].join(", ")}`);
}
// The catch-all's contents, by the directory the sessions ran in. What the Import panel's grouping
// makes editable: a cluster big enough to see here is a cluster worth giving its own space, and
// re-targeting it in the preview is the only chance to do so (`sessions.moveToSpace` refuses once a
// session has events, which an imported one has from the moment it exists).
const clusters = new Map<string, number>();
for (const s of keep) if (!s.match.spaceId) clusters.set(s.cwd || "(no recorded directory)", (clusters.get(s.cwd || "(no recorded directory)") ?? 0) + 1);
if (clusters.size > 0) {
  console.log("\n  unmatched, by directory:");
  for (const [dir, n] of [...clusters].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(n).padStart(4)} ${dir}`);
  }
}

console.log("\n  newest 15:");
for (const s of keep.slice(0, 15)) {
  console.log(`    ${new Date(s.updatedAt).toISOString().slice(0, 10)} ${s.agentKind.padEnd(11)} ${String(s.messages).padStart(4)}m ${s.cwdExists ? "↻" : " "} ${s.title.slice(0, 42).padEnd(42)} → ${target(s.match)}`);
}

console.log(`\nmemory: ${scan.memories.length} folders`);
for (const m of scan.memories) {
  console.log(`  ${String(m.files).padStart(3)} files ${String(Math.round(m.bytes / 1024)).padStart(4)}kB  → ${target(m.match)} (${m.match.reason})  ${m.cwd || m.path}`);
}

const newSkills = scan.skills.filter((s) => !s.imported);
console.log(`\nskills: ${scan.skills.length} found, ${newSkills.length} not yet in the library`);
for (const s of newSkills) console.log(`  ${s.key.padEnd(32)} [${s.origins.join(", ")}] ${s.description.slice(0, 60)}`);

db.close();

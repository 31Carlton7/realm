/**
 * Undo an import.
 *
 * The safety net the Import tab does not have. An imported session cannot be moved afterwards —
 * `sessions.moveToSpace` refuses once a session has persisted events, and an imported one has a whole
 * transcript from the moment it exists — so a run that landed things in the wrong spaces can only be
 * corrected by taking it back out and importing again.
 *
 * **Only rows whose dispatch origin is `import` are ever touched.** A session the user actually had
 * is out of scope whatever is passed on the command line, and no file in `~/.claude`, `~/.codex` or
 * `~/.cursor` is read or written here at all — undoing an import cannot cost anyone their history,
 * because the history was only ever copied.
 *
 * Usage, from `apps/server`:
 *   tsx scripts/undo-import.ts --all-imported [--sweep-environments]
 *   tsx scripts/undo-import.ts <providerSessionId>…
 *
 * `--sweep-environments` is usually wanted with `--all-imported`; see the sweep's own comment below
 * for why leaving those rows behind makes the NEXT import wrong.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database";
import { EnvironmentsStore } from "../src/store/environments";
import { ItemsStore } from "../src/store/items";
import { SessionsStore } from "../src/store/sessions";
import { SettingsStore } from "../src/store/settings";
import { SpacesStore } from "../src/store/spaces";

const home = join(homedir(), "Realm");
const db = openDatabase(join(home, "realm.db"));
db.exec("PRAGMA busy_timeout = 15000");
const sessions = new SessionsStore(db);
const items = new ItemsStore(db);

const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const all = process.argv.includes("--all-imported");
if (ids.length === 0 && !all) { console.error("usage: repair-import.ts [--all-imported | <providerSessionId>…]"); process.exit(1); }

/** Only ever rows whose origin is `import`. A session the user actually had is never in scope here,
 *  whatever else is passed on the command line. */
const rows = all
  ? db.prepare("SELECT id, title FROM sessions WHERE dispatched_by_kind = 'import'").all() as { id: string; title: string }[]
  : ids.flatMap((providerId) => db.prepare(
    "SELECT id, title FROM sessions WHERE provider_session_id = ? AND dispatched_by_kind = 'import'",
  ).all(providerId) as { id: string; title: string }[]);

for (const r of rows) {
  const item = items.findByRefId(r.id);
  // Item first: `sessions.delete` cascades the events but nothing cleans up an orphaned sidebar row.
  if (item) items.delete(item.id);
  sessions.delete(r.id);
}
// The install-once set has to go with them, or a re-import would skip every key it records.
if (all) new SettingsStore(db).set("import.sources", []);
console.log(`deleted ${rows.length} imported session(s)`);

/**
 * Importing a session creates a `checkout` environment at the directory it ran in, and nothing
 * removes one implicitly (EnvironmentsStore's stated lifecycle: a checkout is a directory on disk,
 * and a session is a task that happened to use it).
 *
 * That is right in normal use — and it is exactly what makes a bad import hard to undo. An
 * environment is the STRONGEST match signal, so environments left behind by a wrong run go on
 * out-matching every other rule on the next one: 18 rows pointing the Imported space at 18 project
 * directories re-captured 60 sessions that belonged elsewhere.
 *
 * `--sweep-environments` drops the ones nothing references any more. `EnvironmentsStore.delete` is
 * the guard, not this loop: it refuses a space's primary checkout and refuses any row a session
 * still points at, so a directory the user actually works in cannot be forgotten here.
 */
if (process.argv.includes("--sweep-environments")) {
  const envs = new EnvironmentsStore(db);
  let swept = 0;
  for (const space of new SpacesStore(db, home).listAll()) {
    for (const env of envs.list(space.id)) {
      if (env.kind !== "checkout" || envs.sessionCount(env.id) > 0) continue;
      envs.delete(env.id);
      console.log(`  forgot empty checkout ${env.path} (${space.name})`);
      swept++;
    }
  }
  console.log(`swept ${swept} unreferenced checkout environment(s); no directory was touched`);
}
db.close();

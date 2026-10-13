/**
 * Write the hand-written v50 home (`src/team/v50-fixture.ts`) as a home the built app can boot on: the
 * schema replayed to v50 — what RC2 leaves — with the fixture's rows, its spaces' folders and its
 * teams' memory repos. For live checks on a SCRATCH home only; it refuses a folder that already exists.
 *
 * Usage, from `apps/server`:
 *   tsx scripts/seed-v50-home.ts <new home folder> [--no-leads] [--theme dark|light]
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../src/db/migrations";
import { fixtureRepos, v50Rows } from "../src/team/v50-fixture";

const args = process.argv.slice(2);
const home = args.find((a) => !a.startsWith("--") && !["dark", "light"].includes(a));
if (!home) { console.error("usage: tsx scripts/seed-v50-home.ts <new home folder> [--no-leads] [--theme dark|light]"); process.exit(2); }
if (existsSync(home)) { console.error(`${home} exists — the seed only writes a new scratch home`); process.exit(2); }
const theme = args[args.indexOf("--theme") + 1];
const V51_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_record_types"));
const v50 = V51_AT === -1 ? migrations.length : V51_AT;

mkdirSync(home, { recursive: true });
const repos = fixtureRepos(home, { leads: !args.includes("--no-leads") });
for (const name of ["versed", "research", "bare", "studio", "shop"]) mkdirSync(join(home, "spaces", name), { recursive: true });
const db = new DatabaseSync(join(home, "realm.db"));
db.exec("PRAGMA foreign_keys = ON;");
db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
for (let v = 0; v < v50; v++) { db.exec(migrations[v]!); db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v + 1, Date.now()); }
db.exec(v50Rows({ root: join(home, "spaces"), repos, later: Date.now() + 3 * 86_400_000 }));
if (theme === "dark" || theme === "light") db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('ui.theme', ?)").run(JSON.stringify(theme));
db.close();
console.log(JSON.stringify({ home, version: v50, repos }));

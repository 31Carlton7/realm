/**
 * What the dynamic-Teams migrations would do to a home, without changing it.
 *
 * Copies the database with `VACUUM INTO` (the source is opened read-only), migrates the copy in a
 * scratch folder, runs the record-type reconcile against the copy — reading the teams' memory repos,
 * writing nothing to them — prints what was added and anything lost, and deletes the copy.
 *
 * Usage, from `apps/server`:
 *   tsx scripts/team-migrate-dry-run.ts <path to realm.db> [--json]
 */
import { dryRunMigrations, dryRunWords } from "../src/team/migrate-dry-run";

const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error("usage: tsx scripts/team-migrate-dry-run.ts <path to realm.db> [--json]");
  process.exit(2);
}
const report = dryRunMigrations(path);
console.log(flag === "--json" ? JSON.stringify(report, null, 2) : dryRunWords(report));
process.exit(Object.keys(report.lost).length === 0 ? 0 : 1);

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * A v50 home, written by hand: what Realm's release candidate 2 (Teams Phases 1–5) leaves on disk, as
 * the dynamic-Teams migrations (v51 on) find it. Test-only.
 *
 * It is NOT replayed from `migrations`: a fixture built from the list agrees with any mutation of the
 * list it was built from. The schema is v43–v50's team tables as those migrations wrote them, with the
 * spaces, settings, runs and schedules they hang off; the rows are a creator team (Versed) in every
 * state RC2 can leave it in, a researcher-only team, two teams that are creator teams only by what
 * they did, and a space with no team.
 *
 * `V50_ROWS` is plain INSERTs with every NOT NULL column named, so the same rows also load into a
 * home whose schema WAS replayed — the one the behaviour tests boot the real app on.
 */

/** A ULID-shaped id that reads in a failure: `01` + a two-letter tag + the number, zero-padded. */
export const fid = (tag: string, n: number): string => `01${tag}${String(n).padStart(22, "0")}`;

export const PROFILE = fid("PF", 1);
export const VERSED = fid("SP", 1);
export const RESEARCH = fid("SP", 2);
export const BARE = fid("SP", 3);
/** A team of custom roles only, made a creator team by the slideshows it sent to Review. */
export const STUDIO = fid("SP", 4);
/** A team of custom roles only, made a creator team by the act ticket an approval issued. */
export const SHOP = fid("SP", 5);

export const ROLE = { manager: fid("RB", 1), producer: fid("RB", 2), researcher: fid("RB", 3), custom: fid("RB", 4), former: fid("RB", 5), deskResearcher: fid("RB", 6), studio: fid("RB", 7), shop: fid("RB", 8) };
export const REVIEW = { slides: fid("RV", 1), dm: fid("RV", 2), email: fid("RV", 3), doc: fid("RV", 4), report: fid("RV", 5), deskLeads: fid("RV", 6), studio: fid("RV", 7), shop: fid("RV", 8) };

export const V50_SCHEMA = `
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
  sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, icon TEXT NOT NULL, sort_order INTEGER NOT NULL, folder_path TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, space_id TEXT, created_at INTEGER, role_id TEXT, woke_on TEXT, cost_usd REAL);
CREATE TABLE schedules (id TEXT PRIMARY KEY, role_id TEXT);
CREATE TABLE team_roles (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, brief TEXT NOT NULL, realmite_json TEXT NOT NULL, template TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  skills_json TEXT NOT NULL DEFAULT '[]',
  wake_on_review INTEGER NOT NULL DEFAULT 1,
  week_budget_usd REAL, run_cap_usd REAL NOT NULL DEFAULT 3, run_cap_ms INTEGER NOT NULL DEFAULT 1200000,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  handoffs_json TEXT NOT NULL DEFAULT '[]', wake_on_mention INTEGER NOT NULL DEFAULT 1);
CREATE INDEX team_roles_space ON team_roles(space_id, archived, sort_order);
CREATE TABLE team_reviews (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT, run_id TEXT, session_id TEXT, record_path TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, decided_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE team_review_items (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES team_reviews(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1, ord INTEGER NOT NULL,
  files_json TEXT NOT NULL, body TEXT, target_json TEXT,
  content_hash TEXT NOT NULL, approved_hash TEXT,
  act_state TEXT NOT NULL DEFAULT 'none');
CREATE TABLE team_activity (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, actor TEXT NOT NULL,
  run_id TEXT, session_id TEXT, verb TEXT NOT NULL, object TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE vault_grants (
  secret_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  hosts_json TEXT NOT NULL DEFAULT '[]', purpose TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (secret_id, role_id));
CREATE TABLE team_handoffs (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_role_id TEXT, from_session_id TEXT, to_role_id TEXT NOT NULL,
  record_path TEXT, note TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT, session_id TEXT, outcome TEXT, cost_usd REAL,
  created_at INTEGER NOT NULL, settled_at INTEGER);
CREATE TABLE lab_devices (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, udid TEXT, name TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  accounts_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE team_act_tickets (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL, item_id TEXT NOT NULL,
  kind TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, recipient TEXT,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  slot_at INTEGER NOT NULL, slot_why TEXT NOT NULL DEFAULT 'next',
  pressed_at INTEGER, disclosure TEXT, acted_at INTEGER,
  proof_url TEXT, screenshot TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX team_act_tickets_item ON team_act_tickets(item_id) WHERE state <> 'cancelled';
CREATE TABLE team_act_holds (
  space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  held_at INTEGER NOT NULL);
`;

/** Every table the fixture writes, for the zero-loss comparison. */
export const V50_TABLES = ["profiles", "spaces", "settings", "team_roles", "team_reviews", "team_review_items", "team_activity",
  "vault_grants", "team_handoffs", "lab_devices", "team_act_tickets", "team_act_holds"] as const;

const NATHAN_TIKTOK = '{"channel":"TikTok","account":"@versed.nathan"}';
const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The rows. `root` is where the spaces' folders are; `repos` names the memory repo each team space
 * has (Versed's and the researcher's), written to settings as `MemoryRepoService` keeps them.
 * `later` is a time after which the scheduled ticket's slot falls, so a booted app arms it and acts
 * on nothing during a test.
 */
export function v50Rows(o: { root: string; repos: { versed: string; research: string }; later: number }): string {
  const t0 = 1_760_000_000_000; // 2025-10-09
  const lines: string[] = [];
  const add = (sql: string) => lines.push(sql.trim().replace(/\s+\n/g, "\n") + ";");
  add(`INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (${sq(PROFILE)}, 'Carlton', 'user', '#336699', 0, ${t0}, ${t0})`);
  const space = (id: string, name: string, n: number) => add(`INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at)
    VALUES (${sq(id)}, ${sq(PROFILE)}, ${sq(name)}, 'folder', ${n}, ${sq(join(o.root, name.toLowerCase()))}, ${t0 + n}, ${t0 + n})`);
  space(VERSED, "Versed", 1); space(RESEARCH, "Research", 2); space(BARE, "Bare", 3); space(STUDIO, "Studio", 4); space(SHOP, "Shop", 5);

  const setting = (k: string, v: unknown) => add(`INSERT INTO settings (key, value_json) VALUES (${sq(k)}, ${sq(JSON.stringify(v))})`);
  setting(`team.weekBudget:${VERSED}`, 60);
  setting(`team.maxLive:${VERSED}`, 2);
  setting(`memory.repo:space:${VERSED}`, { path: o.repos.versed, push: false, pushRemote: null });
  setting(`memory.repo:space:${RESEARCH}`, { path: o.repos.research, push: false, pushRemote: null });
  setting("team.slots", 3);

  const role = (id: string, sp: string, name: string, template: string | null, n: number, extra: { archived?: boolean; handoffs?: string[]; budget?: number } = {}) =>
    add(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, template, agent_kind, model, effort, permission_mode, skills_json, wake_on_review,
      week_budget_usd, run_cap_usd, run_cap_ms, max_concurrent, archived, sort_order, created_at, updated_at, handoffs_json, wake_on_mention)
      VALUES (${sq(id)}, ${sq(sp)}, ${sq(name)}, ${sq(`${name}'s brief: keep creators/ current.`)}, ${sq(`{"seed":"${name}"}`)}, ${template ? sq(template) : "NULL"},
      'claude', 'sonnet', NULL, 'default', '[]', 1, ${extra.budget ?? "NULL"}, 3, 1200000, 1, ${extra.archived ? 1 : 0}, ${n}, ${t0 + 100 + n}, ${t0 + 200 + n},
      ${sq(JSON.stringify(extra.handoffs ?? []))}, 1)`);
  role(ROLE.manager, VERSED, "Creator Manager", "creator-manager", 0, { budget: 20 });
  role(ROLE.producer, VERSED, "Content Producer", "content-producer", 1, { budget: 25, handoffs: [ROLE.manager] });
  role(ROLE.researcher, VERSED, "Researcher", "researcher", 2, { budget: 10 });
  role(ROLE.custom, VERSED, "Deal Desk", null, 3);
  // The custom role is the team's oldest, so its meta row dates from it — not from a starter.
  add(`UPDATE team_roles SET created_at = ${t0 + 50} WHERE id = ${sq(ROLE.custom)}`);
  role(ROLE.former, VERSED, "Old Scout", "researcher", 4, { archived: true });
  role(ROLE.deskResearcher, RESEARCH, "Researcher", "researcher", 0, { budget: 10 });
  role(ROLE.studio, STUDIO, "Slides", null, 0);
  role(ROLE.shop, SHOP, "Outreach", null, 0);

  const review = (id: string, sp: string, roleId: string | null, kind: string, title: string, state: string, recordPath: string | null, version = 1, note: string | null = null) =>
    add(`INSERT INTO team_reviews (id, space_id, role_id, run_id, session_id, record_path, kind, title, state, note, version, created_at, decided_at, updated_at)
      VALUES (${sq(id)}, ${sq(sp)}, ${roleId ? sq(roleId) : "NULL"}, NULL, NULL, ${recordPath ? sq(recordPath) : "NULL"}, ${sq(kind)}, ${sq(title)}, ${sq(state)},
      ${note ? sq(note) : "NULL"}, ${version}, ${t0 + 1000}, ${state === "waiting" ? "NULL" : t0 + 2000}, ${t0 + 3000})`);
  review(REVIEW.slides, VERSED, ROLE.producer, "slideshows", "2 slideshows for Nathan", "approved", "creators/nathan-beyenhof.md", 2);
  review(REVIEW.dm, VERSED, ROLE.manager, "message", "A DM to a reader", "waiting", "creators/nathan-beyenhof.md");
  review(REVIEW.email, VERSED, ROLE.manager, "message", "Email Nathan the brief", "changes", "creators/nathan-beyenhof.md", 1, "Shorter, and say the rate.");
  review(REVIEW.doc, VERSED, ROLE.researcher, "document", "Contract v3, redlined", "done", null);
  review(REVIEW.report, VERSED, ROLE.researcher, "report", "What TikTok allows", "dismissed", null);
  review(REVIEW.deskLeads, RESEARCH, ROLE.deskResearcher, "report", "Acme, researched", "waiting", "leads/acme.md");
  review(REVIEW.studio, STUDIO, ROLE.studio, "slideshows", "3 slideshows", "waiting", null);
  review(REVIEW.shop, SHOP, ROLE.shop, "message", "A DM", "approved", null);

  let item = 0;
  const it = (reviewId: string, version: number, ord: number, files: string[], body: string | null, target: string | null, hash: string, approved: string | null, actState: string) =>
    add(`INSERT INTO team_review_items (id, review_id, version, ord, files_json, body, target_json, content_hash, approved_hash, act_state)
      VALUES (${sq(fid("TM", ++item))}, ${sq(reviewId)}, ${version}, ${ord}, ${sq(JSON.stringify(files))}, ${body === null ? "NULL" : sq(body)}, ${target === null ? "NULL" : sq(target)},
      ${sq(hash)}, ${approved === null ? "NULL" : sq(approved)}, ${sq(actState)})`);
  // Version 1 of the slideshows, one step back; version 2 approved, its two items ready to act.
  it(REVIEW.slides, 1, 0, ["deck/a1.png", "deck/a2.png"], "studying, not highlighting #ad", NATHAN_TIKTOK, "h-s1-0", null, "none");
  it(REVIEW.slides, 1, 1, ["deck/b1.png"], "the fade #ad", NATHAN_TIKTOK, "h-s1-1", null, "none");
  it(REVIEW.slides, 2, 0, ["deck/a1.png", "deck/a2.png"], "studying, not highlighting. it isn't #ad", NATHAN_TIKTOK, "h-s2-0", "h-s2-0", "ready");
  it(REVIEW.slides, 2, 1, ["deck/b1.png"], "the fade, part two #ad", NATHAN_TIKTOK, "h-s2-1", "h-s2-1", "ready");
  it(REVIEW.dm, 1, 0, [], "Thanks for the comment!", '{"channel":"Instagram","account":"@versed.nathan","to":"@reader"}', "h-dm", null, "none");
  it(REVIEW.email, 1, 0, [], "Hi Nathan, the brief is attached.", '{"channel":"email","account":"carlton@charmtechnologies.co","to":"nathan.beyenhof@gmail.com"}', "h-em", null, "none");
  it(REVIEW.doc, 1, 0, ["contracts/nathan-v3.pdf"], null, null, "h-doc", "h-doc", "none");
  it(REVIEW.report, 1, 0, [], "TikTok allows managed accounts with consent.", null, "h-rep", null, "none");
  it(REVIEW.deskLeads, 1, 0, ["notes/acme.md"], null, null, "h-lead", null, "none");
  it(REVIEW.studio, 1, 0, ["s/1.png"], "caption", null, "h-st", null, "none");
  it(REVIEW.shop, 1, 0, [], "hello", '{"channel":"Instagram","account":"@shop"}', "h-sh", "h-sh", "ready");

  const ticket = (n: number, sp: string, reviewId: string, itemN: number, kind: string, channel: string, account: string, state: string, slotAt: number, extra: Record<string, string | number | null> = {}) =>
    add(`INSERT INTO team_act_tickets (id, space_id, review_id, item_id, kind, channel, account, recipient, content_hash, state, slot_at, slot_why,
      pressed_at, disclosure, acted_at, proof_url, screenshot, error, created_at, updated_at)
      VALUES (${sq(fid("TK", n))}, ${sq(sp)}, ${sq(reviewId)}, ${sq(fid("TM", itemN))}, ${sq(kind)}, ${sq(channel)}, ${sq(account)}, ${extra.recipient ? sq(String(extra.recipient)) : "NULL"},
      ${sq(String(extra.hash ?? `h-${n}`))}, ${sq(state)}, ${slotAt}, ${sq(String(extra.why ?? "next"))}, ${extra.pressed ?? "NULL"}, ${extra.disclosure ? sq(String(extra.disclosure)) : "NULL"},
      ${extra.acted ?? "NULL"}, ${extra.proof ? sq(String(extra.proof)) : "NULL"}, ${extra.shot ? sq(String(extra.shot)) : "NULL"}, ${extra.error ? sq(String(extra.error)) : "NULL"}, ${t0 + 4000 + n}, ${t0 + 5000 + n})`);
  ticket(1, VERSED, REVIEW.slides, 3, "post", "TikTok", "@versed.nathan", "ready", t0 + 7_200_000, { hash: "h-s2-0" });
  ticket(2, VERSED, REVIEW.slides, 4, "post", "TikTok", "@versed.nathan", "scheduled", o.later, { hash: "h-s2-1", pressed: t0 + 6000, disclosure: "caption", why: "gap" });
  ticket(3, VERSED, REVIEW.slides, 1, "post", "TikTok", "@versed.nathan", "done", t0 - 86_400_000, { hash: "h-s1-0", pressed: t0 - 90_000_000, acted: t0 - 86_000_000, proof: "https://www.tiktok.com/@versed.nathan/video/1", shot: "team-proof/1.png" });
  ticket(4, VERSED, REVIEW.slides, 2, "post", "TikTok", "@versed.nathan", "cancelled", t0 - 80_000_000, { hash: "h-s1-1", error: "a newer version replaced it" });
  ticket(5, SHOP, REVIEW.shop, 11, "dm", "Instagram", "@shop", "acting", t0 - 70_000_000, { hash: "h-sh", pressed: t0 - 71_000_000, recipient: "@buyer" });
  add(`INSERT INTO team_act_holds (space_id, held_at) VALUES (${sq(RESEARCH)}, ${t0 + 9000})`);

  add(`INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, hosts_json, purpose, created_at)
    VALUES ('sec-1', ${sq(VERSED)}, ${sq(ROLE.producer)}, 'signin', 'tiktok.com/nathan', '["tiktok.com"]', 'post for Nathan', ${t0 + 300})`);
  add(`INSERT INTO team_handoffs (id, space_id, kind, from_role_id, from_session_id, to_role_id, record_path, note, files_json, run_id, session_id, outcome, cost_usd, created_at, settled_at)
    VALUES (${sq(fid("HF", 1))}, ${sq(VERSED)}, 'handoff', ${sq(ROLE.producer)}, NULL, ${sq(ROLE.manager)}, 'creators/nathan-beyenhof.md', 'Slides are done; draft the DM.', '["deck/a1.png"]', NULL, NULL, NULL, NULL, ${t0 + 400}, NULL)`);
  add(`INSERT INTO lab_devices (id, kind, udid, name, space_id, accounts_json, last_seen_at, created_at, updated_at)
    VALUES (${sq(fid("DV", 1))}, 'iphone', '00008110-AAAA', 'lab-iphone-2', ${sq(VERSED)}, '[{"service":"TikTok","handle":"@versed.nathan"}]', ${t0 + 500}, ${t0 + 500}, ${t0 + 500})`);
  const verbs = ["made_team", "made_role", "woke", "read_record", "updated_record", "submitted", "approved", "issued_tickets", "pressed", "acted", "asked_changes", "handed_off", "revised", "dismissed", "marked_done", "held_acts", "resumed_acts", "finished", "queued", "refused"];
  for (let n = 0; n < 40; n++) {
    add(`INSERT INTO team_activity (id, space_id, ts, actor, run_id, session_id, verb, object, detail_json)
      VALUES (${sq(fid("AC", n + 1))}, ${sq(n % 10 === 9 ? STUDIO : VERSED)}, ${t0 + 10_000 + n}, ${sq(n % 3 === 0 ? "user" : `role:${ROLE.producer}`)}, NULL, NULL, ${sq(verbs[n % verbs.length]!)},
      ${sq(`line ${n}`)}, ${sq(JSON.stringify({ n, path: "creators/nathan-beyenhof.md" }))})`);
  }
  return lines.join("\n");
}

/** Nathan's record exactly as the Teams plan's section 8 writes it. */
export const NATHAN = `# Nathan Beyenhof
- Status: signed [source: realm:session/01M4AQ3QPKR38FR40JCCG9QSXA; added: 2026-10-07]
- Contact: Nathan.beyenhof@gmail.com · iMessage
- Sends from: carlton@charmtechnologies.co

## Deal
- Term: 2026-10-08 to 2026-11-07
- Rate: $5 per video + $2.50 CPM [source: realm:session/01M4AQ3QPKR38FR40JCCG9QSXA]
- Payment: Venmo (you send it)
- Formats: talk to camera, Bible journaling; new formats by approval
- Competitor clause: Haven removed (v3)
- Contract: [[contracts/nathan-beyenhof/v3.pdf]]
- Creator code: NATHAN5

## Accounts
- TikTok @versed.nathan · vault: tiktok.com/nathan · device: lab-iphone-2 · consent: contract §4
- Instagram @versed.nathan · vault: instagram.com/nathan · device: lab-iphone-2 · consent: contract §4
- YouTube Shorts: waiting on Nathan

## Deadlines
- 2026-10-08 first post · done
- weekly: 3 videos

## Content
- 2026-10-05 "The fade" 1/3 · TikTok · review:01M… · views 4,812 [added: 2026-10-06]
`;

export const CREATOR_TEMPLATE_FILE = "# Name\n- Status: prospect\n\n## Deal\n\n## Accounts\n\n## Deadlines\n\n## Content\n";
export const FREE_FORM_NOTES = "Notes from the call with Nathan.\n\nHe wants to try a series on journaling.\n";
export const ACME = `# Acme Corp
- Status: contacted
- Contact: dana@acme.com
- Sends from: you@versed.app

## People
- Dana Lee · role: head of growth · contact: dana@acme.com

## Touches
- 2026-10-01 first email · sent
- 2026-10-04 follow-up · sent
`;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@realm.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

/** A memory repo holding the given files, committed: what RC2's team left in git. */
export function fixtureRepo(path: string, files: Record<string, string>): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  writeFileSync(join(path, "MEMORY.md"), "# Memory\n\n## Index\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(path, rel, ".."), { recursive: true });
    writeFileSync(join(path, rel), text);
  }
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "RC2's records");
  return path;
}

/** Versed's repo (§2.6: Nathan, the template, a free-form file, and a lead) and the researcher's (a
 *  `creators/` folder a person added by hand, which no SQL signal can see). */
export function fixtureRepos(root: string, o: { leads?: boolean } = {}): { versed: string; research: string } {
  return {
    versed: fixtureRepo(join(root, "repos", "versed"), {
      "creators/nathan-beyenhof.md": NATHAN, "creators/_template.md": CREATOR_TEMPLATE_FILE, "creators/notes.md": FREE_FORM_NOTES,
      ...(o.leads === false ? {} : { "leads/acme.md": ACME }),
    }),
    research: fixtureRepo(join(root, "repos", "research"), { "creators/nathan-beyenhof.md": NATHAN }),
  };
}

/** Every row of every fixture table, in a stable order, on the columns the table had at v50. */
export function snapshot(db: DatabaseSync, tables: readonly string[] = V50_TABLES, columns?: Record<string, string[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const cols = columns?.[t] ?? (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    out[t] = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${t}" ORDER BY ${cols.map((c) => `"${c}"`).join(", ")}`).all();
  }
  return out;
}

export function columnsOf(db: DatabaseSync, tables: readonly string[] = V50_TABLES): Record<string, string[]> {
  return Object.fromEntries(tables.map((t) => [t, (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)]));
}

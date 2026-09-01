import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";
import { migrations } from "./migrations";
import { SettingsStore } from "../store/settings";
import { SpacesStore } from "../store/spaces";
import { McpServersStore } from "../store/mcp";
import { McpService } from "../mcp/service";
import { SkillsService } from "../skills/service";
import { MemoryService } from "../memory/service";

/**
 * The migration mutant, killed with a hand-written fixture: a realm.db as Plan 12 W2 FINDS it — two
 * profiles, three spaces, MCP rows with per-space enabled-sets, a skills library with per-space
 * disables, a memory doc — written at schema v10 by hand, migrated by `openDatabase`, and then asked
 * for every space's effective sets, which must match the PRE-migration semantics byte for byte:
 *
 *   - MCP:    effective(space) = exactly its old `mcp.enabled:<spaceId>` set
 *   - skills: effective(space) = every library dir minus its old `skills.disabled:<spaceId>` set
 *   - memory: the injected context = exactly the space doc, no profile part
 *
 * Nothing here calls promote/demote or writes a scope: this is the upgrade path alone.
 */

const V11 = 11;

const PA = "01ARZ3NDEKTSV4RRFFQ69G5PA1";
const PB = "01ARZ3NDEKTSV4RRFFQ69G5PB1";
const S1 = "01ARZ3NDEKTSV4RRFFQ69G5SA1"; // PA
const S2 = "01ARZ3NDEKTSV4RRFFQ69G5SA2"; // PA
const S3 = "01ARZ3NDEKTSV4RRFFQ69G5SB1"; // PB
const M1 = "01ARZ3NDEKTSV4RRFFQ69G5MM1";
const M2 = "01ARZ3NDEKTSV4RRFFQ69G5MM2";

function writeV10Fixture(home: string): string {
  const path = join(home, "realm.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  // Guard: if v11 is no longer the scoping migration this fixture is aimed at, fail loudly here
  // rather than silently pre-applying the very migration under test. (Later migrations may exist —
  // W5 added v12 — so the guard pins WHAT v11 is, not that it is last.)
  expect(migrations.length).toBeGreaterThanOrEqual(V11);
  expect(migrations[V11 - 1]).toContain("ALTER TABLE mcp_servers ADD COLUMN scope");
  for (let v = 0; v < V11 - 1; v++) {
    db.exec(migrations[v]!);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v + 1, Date.now());
  }
  const t = 1000;
  const profile = db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, 'x', '#000', ?, ?, ?)");
  profile.run(PA, "Work life", 0, t, t);
  profile.run(PB, "Personal", 1, t, t);
  const space = db.prepare(`INSERT INTO spaces (id, profile_id, name, icon, color, sort_order, folder_path, layout_json, active_item_id, created_at, updated_at)
    VALUES (?, ?, ?, 'folder', '#7c6cff', ?, ?, NULL, NULL, ?, ?)`);
  space.run(S1, PA, "Alpha", 0, join(home, "wa"), t, t);
  space.run(S2, PA, "Beta", 1, join(home, "wb"), t, t);
  space.run(S3, PB, "Home", 2, join(home, "ph"), t, t);
  const server = db.prepare(`INSERT INTO mcp_servers (id, name, transport, command, args_json, url, secrets_json, oauth_json, tools_json, created_at, updated_at)
    VALUES (?, ?, 'stdio', '/usr/bin/node', '[]', '', '{}', '', '[]', ?, ?)`);
  server.run(M1, "airtable", t, t);
  server.run(M2, "linear", t + 1, t + 1);
  const setting = db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
  // The pre-W2 state this fixture freezes: M1 enabled in S1 and S3 (two spaces, two PROFILES — the
  // case no defining-space backfill could represent), M2 in S3 only, skill "alpha" disabled in S2.
  setting.run(`mcp.enabled:${S1}`, JSON.stringify([M1]));
  setting.run(`mcp.enabled:${S3}`, JSON.stringify([M1, M2].sort()));
  setting.run(`skills.disabled:${S2}`, JSON.stringify(["alpha"]));
  db.close();

  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(home, "skills", id), { recursive: true });
    writeFileSync(join(home, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: does ${id}.\n---\n`);
  }
  mkdirSync(join(home, "memory"), { recursive: true });
  writeFileSync(join(home, "memory", `${S1}.md`), "alpha standing instructions");
  return path;
}

describe("v11 scoping migration", () => {
  it("changes NO space's effective set: pre-migration state comes out byte-identical", () => {
    const home = mkdtempSync(join(tmpdir(), "realm-scoping-mig-"));
    const path = writeV10Fixture(home);

    const db = openDatabase(path); // applies v11 (and whatever came after — W5's v12 rides along)
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    // Every migrated row is a pre-scoping space row — no backfill guessed a defining space or profile.
    expect(db.prepare("SELECT scope, scope_space_id, scope_profile_id FROM mcp_servers").all())
      .toEqual([{ scope: "space", scope_space_id: null, scope_profile_id: null }, { scope: "space", scope_space_id: null, scope_profile_id: null }]);

    // The exact wiring app.ts builds.
    const settings = new SettingsStore(db);
    const spaces = new SpacesStore(db, home);
    const scopeSeam = {
      profileIdOf: (spaceId: string): string | null => spaces.get(spaceId)?.profileId ?? null,
      spaceIdsOf: (profileId: string): string[] => spaces.list(profileId).map((sp) => sp.id),
      allSpaceIds: (): string[] => spaces.listAll().map((sp) => sp.id),
    };
    const mcp = new McpService({ servers: new McpServersStore(db), settings, scopes: scopeSeam });
    const skills = new SkillsService({ home, settings, bundledDir: null, scopes: scopeSeam });
    const memory = new MemoryService({ home, settings, scopes: scopeSeam,
      environments: { ensurePrimary: (spaceId) => ({ id: `env-${spaceId}`, spaceId, path: join(home, "x"), branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 }) },
      claudeDir: join(home, "no-claude") });

    // Hand-written pre-migration effective sets — the old semantics, stated, not recomputed.
    expect(mcp.effectiveServerIds(S1)).toEqual([M1]);
    expect(mcp.effectiveServerIds(S2)).toEqual([]);
    expect(mcp.effectiveServerIds(S3)).toEqual([M1, M2]);
    const enabledSkills = (sid: string) => skills.list(sid).skills.filter((s) => s.enabled).map((s) => s.id);
    expect(skills.list(S1).skills.map((s) => s.id)).toEqual(["alpha", "beta"]); // still listed everywhere
    expect(enabledSkills(S1)).toEqual(["alpha", "beta"]);
    expect(enabledSkills(S2)).toEqual(["beta"]);
    expect(enabledSkills(S3)).toEqual(["alpha", "beta"]);
    // Memory: the injected context is the space doc alone, byte-identical to what v10 injected.
    expect(memory.systemContextFor({ spaceId: S1, kind: "codex", cwd: "/tmp", skillsInjected: false }))
      .toBe("# Space memory\n\nThe user keeps this context for every session in this workspace (managed in Realm):\n\nalpha standing instructions");
    expect(memory.systemContextFor({ spaceId: S2, kind: "codex", cwd: "/tmp", skillsInjected: false })).toBeUndefined();
    db.close();
  });
});

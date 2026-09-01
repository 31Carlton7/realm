import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { RpcError } from "../store/rows";
import { SkillsService, bundledSkillsDir, skillsRoot } from "./service";

let home: string;
let bundled: string;
let service: SkillsService;
let settings: SettingsStore;
const SPACE = "spc_1";

const skill = (dir: string, id: string, body = `---\nname: ${id}\ndescription: does ${id}.\n---\n\n# ${id}\n`) => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "SKILL.md"), body);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realm-skills-home-"));
  bundled = mkdtempSync(join(tmpdir(), "realm-skills-bundle-"));
  settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  service = new SkillsService({ home, settings, bundledDir: bundled });
});
afterEach(() => {
  for (const d of [home, bundled]) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ids = (spaceId = SPACE) => service.list(spaceId).skills.map((s) => s.id);
const byId = (id: string, spaceId = SPACE) => service.list(spaceId).skills.find((s) => s.id === id)!;
const staged = (inj: { root: string }) => readdirSync(inj.root).sort();

describe("SkillsService.list", () => {
  it("is empty, not an error, before the library directory exists", () => {
    expect(service.list(SPACE)).toEqual({ root: skillsRoot(home), skills: [] });
  });

  it("reads name and description off each SKILL.md, enabled by default", () => {
    skill(service.root, "mac");
    expect(service.list(SPACE).skills).toEqual([
      { id: "mac", name: "mac", description: "does mac.", path: join(service.root, "mac", "SKILL.md"), enabled: true, valid: true, reason: null,
        scope: { kind: "space", spaceId: null } },
    ]);
  });

  it("lists a malformed skill as invalid rather than hiding it", () => {
    // Silence is the failure mode here: a skill that vanished because of a typo has to be findable, or the
    // user's only debugging tool is guessing.
    skill(service.root, "no-fence", "# not a skill\n");
    skill(service.root, "no-name", "---\ndescription: x\n---\n");
    skill(service.root, "no-description", "---\nname: y\n---\n");
    mkdirSync(join(service.root, "no-file"), { recursive: true });
    skill(service.root, "good");
    expect(ids()).toEqual(["good", "no-description", "no-fence", "no-file", "no-name"]);
    expect(byId("no-fence").reason).toMatch(/frontmatter/);
    expect(byId("no-name").reason).toMatch(/`name`/);
    expect(byId("no-description").reason).toMatch(/`description`/);
    expect(byId("no-file").reason).toMatch(/no SKILL.md/);
    expect(service.list(SPACE).skills.filter((s) => s.valid).map((s) => s.id)).toEqual(["good"]);
  });

  it("skips dotfiles, loose files and names that are not addressable ids", () => {
    skill(service.root, "good");
    mkdirSync(join(service.root, ".git"), { recursive: true });
    mkdirSync(join(service.root, "has space"), { recursive: true });
    writeFileSync(join(service.root, "README.md"), "hi");
    expect(ids()).toEqual(["good"]);
  });
});

describe("SkillsService per-space enable/disable", () => {
  it("disables a skill for one space and leaves every other space alone", () => {
    skill(service.root, "mac");
    skill(service.root, "notes");
    service.setEnabled(SPACE, "mac", false);
    expect(byId("mac").enabled).toBe(false);
    expect(byId("notes").enabled).toBe(true);
    expect(byId("mac", "spc_2").enabled).toBe(true);
    service.setEnabled(SPACE, "mac", true);
    expect(byId("mac").enabled).toBe(true);
  });

  it("remembers a preference for a skill that is not on disk right now", () => {
    // Deleting a skill and putting it back must not silently re-enable it — the folder is the user's, and
    // they move things around in it.
    service.setEnabled(SPACE, "mac", false);
    skill(service.root, "mac");
    expect(byId("mac").enabled).toBe(false);
  });
});

describe("SkillsService.injectionFor", () => {
  it("stages a directory that is a Claude plugin and a Codex root at once", () => {
    skill(service.root, "mac");
    const inj = service.injectionFor(SPACE, "claude")!;
    expect(inj.root).toBe(join(inj.pluginPath, "skills"));
    const manifest = JSON.parse(readFileSync(join(inj.pluginPath, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    expect(manifest.name).toBe("realm");
    expect(staged(inj)).toEqual(["mac"]);
    // A symlink, not a copy: an edit the user makes mid-session is live, and both agents resolve it.
    expect(realpathSync(join(inj.root, "mac"))).toBe(realpathSync(join(service.root, "mac")));
  });

  it("leaves a disabled skill out of the staged root", () => {
    skill(service.root, "mac");
    skill(service.root, "notes");
    service.setEnabled(SPACE, "notes", false);
    expect(staged(service.injectionFor(SPACE, "claude")!)).toEqual(["mac"]);
  });

  it("leaves an invalid skill out of the staged root however enabled it is", () => {
    skill(service.root, "mac");
    skill(service.root, "broken", "not frontmatter at all");
    expect(byId("broken").enabled).toBe(true);
    expect(staged(service.injectionFor(SPACE, "claude")!)).toEqual(["mac"]);
  });

  it("returns null when nothing is enabled, so Claude keeps the user's own settings", () => {
    // Null rather than an empty root on purpose: on Claude the option's *presence* is what sets
    // `settingSources: []`, so an empty library must not cost the user their CLAUDE.md.
    expect(service.injectionFor(SPACE, "claude")).toBeNull();
    skill(service.root, "mac");
    service.setEnabled(SPACE, "mac", false);
    expect(service.injectionFor(SPACE, "claude")).toBeNull();
  });

  it("returns null for the agents that have no route for a skills directory", () => {
    skill(service.root, "mac");
    expect(service.injectionFor(SPACE, "acp:cursor")).toBeNull();
    expect(service.injectionFor(SPACE, "acp:gemini")).toBeNull();
    expect(service.injectionFor(SPACE, "fake")).toBeNull();
    expect(service.injectionFor(SPACE, "codex")).not.toBeNull();
  });

  it("stages each space separately", () => {
    skill(service.root, "mac");
    skill(service.root, "notes");
    service.setEnabled("spc_a", "notes", false);
    const a = service.injectionFor("spc_a", "codex")!;
    const b = service.injectionFor("spc_b", "codex")!;
    expect(a.root).not.toBe(b.root);
    expect(staged(a)).toEqual(["mac"]);
    expect(staged(b)).toEqual(["mac", "notes"]);
  });

  it("rebuilds the staged root rather than reconciling it", () => {
    skill(service.root, "mac");
    skill(service.root, "notes");
    const first = service.injectionFor(SPACE, "codex")!;
    expect(staged(first)).toEqual(["mac", "notes"]);
    rmSync(join(service.root, "notes"), { recursive: true, force: true });
    // A stale symlink to a skill that is gone is exactly what reconciliation would leave behind, and both
    // agents would then log an unreadable root.
    expect(staged(service.injectionFor(SPACE, "codex")!)).toEqual(["mac"]);
  });

  it("degrades to null instead of throwing when staging itself fails", () => {
    skill(service.root, "mac");
    // A session with no skills is a smaller failure than a session that will not start.
    writeFileSync(join(home, ".cache"), "not a directory"); // nothing can be staged underneath a file
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(service.injectionFor(SPACE, "claude")).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("SkillsService.installBundled", () => {
  it("copies a repo-shipped skill into the library on first boot", () => {
    skill(bundled, "mac");
    expect(service.installBundled()).toEqual(["mac"]);
    expect(byId("mac").valid).toBe(true);
    // Copied, not linked: `~/Realm/skills` is the user's folder, and a skill they cannot edit is not theirs.
    expect(readFileSync(join(service.root, "mac", "SKILL.md"), "utf8")).toContain("name: mac");
  });

  it("installs once — a skill the user deletes stays deleted", () => {
    skill(bundled, "mac");
    expect(service.installBundled()).toEqual(["mac"]);
    rmSync(join(service.root, "mac"), { recursive: true, force: true });
    expect(service.installBundled()).toEqual([]);
    expect(ids()).toEqual([]);
  });

  it("never overwrites a skill the user has edited", () => {
    skill(bundled, "mac");
    skill(service.root, "mac", "---\nname: mac\ndescription: mine now.\n---\n");
    // Present already but not yet recorded: it must be adopted, not clobbered.
    expect(service.installBundled()).toEqual([]);
    expect(byId("mac").description).toBe("mine now.");
    expect(service.installBundled()).toEqual([]);
  });

  it("copies the whole skill directory, not just SKILL.md", () => {
    skill(bundled, "mac");
    mkdirSync(join(bundled, "mac", "references"), { recursive: true });
    writeFileSync(join(bundled, "mac", "references", "cli.md"), "reference");
    service.installBundled();
    expect(readFileSync(join(service.root, "mac", "references", "cli.md"), "utf8")).toBe("reference");
  });

  it("does nothing when there are no bundled skills", () => {
    expect(new SkillsService({ home, settings, bundledDir: null }).installBundled()).toEqual([]);
    expect(service.installBundled()).toEqual([]); // empty bundle dir
  });

  it("ignores a bundled directory with no SKILL.md", () => {
    mkdirSync(join(bundled, "scripts"), { recursive: true });
    expect(service.installBundled()).toEqual([]);
  });
});

describe("bundledSkillsDir", () => {
  it("finds the repo's own skills directory, which is where skills/mac lives", () => {
    const dir = bundledSkillsDir();
    expect(dir).not.toBeNull();
    expect(readdirSync(dir!)).toContain("mac");
  });

  it("honours REALM_BUNDLED_SKILLS, and reports nothing when it points nowhere", () => {
    vi.stubEnv("REALM_BUNDLED_SKILLS", bundled);
    expect(bundledSkillsDir()).toBe(bundled);
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(bundled, "missing"));
    expect(bundledSkillsDir()).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("scoping (W2) — profile vs space defining scope", () => {
  // Two profiles, three spaces: A1/A2 belong to PA, B1 to PB. The seam is exactly what app.ts wires
  // from SpacesStore, reduced to the one question SkillsService asks.
  const A1 = "spc_a1", A2 = "spc_a2", B1 = "spc_b1";
  const profileOf: Record<string, string> = { [A1]: "PA", [A2]: "PA", [B1]: "PB" };
  const scoped = () => new SkillsService({ home, settings, bundledDir: null, scopes: { profileIdOf: (sid) => profileOf[sid] ?? null } });

  it("keeps a pre-scoping skill visible and toggleable in every space of every profile", () => {
    // The migration IS the absence of a scope entry: nothing written on upgrade, nothing moves.
    const svc = scoped();
    skill(svc.root, "mac");
    for (const sp of [A1, A2, B1]) expect(svc.list(sp).skills.map((x) => [x.id, x.enabled])).toEqual([["mac", true]]);
    expect(svc.list(A1).skills[0]!.scope).toEqual({ kind: "space", spaceId: null });
  });

  it("promote scopes a skill to the profile: inherited by every space of THAT profile and no other", () => {
    // The named mutant: inheritance math wrong — a PA-scoped skill leaking into PB's space.
    const svc = scoped();
    skill(svc.root, "mac");
    svc.promote(A1, "mac");
    expect(svc.list(A1).skills.map((x) => x.id)).toEqual(["mac"]);
    expect(svc.list(A2).skills.map((x) => x.id)).toEqual(["mac"]);
    expect(svc.list(B1).skills).toEqual([]);
    expect(svc.list(A2).skills[0]!.scope).toEqual({ kind: "profile", profileId: "PA" });
  });

  it("promote never arms a space that had the skill disabled", () => {
    // The named mutant: promotion silently re-enabling. Skills share ONE per-space disabled-set across
    // both scopes, so the preservation is structural — this test is what notices if that ever splits.
    const svc = scoped();
    skill(svc.root, "mac");
    svc.setEnabled(A2, "mac", false);
    svc.promote(A1, "mac");
    expect(svc.list(A1).skills[0]!.enabled).toBe(true);
    expect(svc.list(A2).skills[0]!.enabled).toBe(false);
  });

  it("disabling an inherited skill in one space leaves its sibling alone", () => {
    // The named mutant: a per-space override bleeding across siblings.
    const svc = scoped();
    skill(svc.root, "mac");
    svc.promote(A1, "mac");
    svc.setEnabled(A1, "mac", false);
    expect(svc.list(A1).skills[0]!.enabled).toBe(false);
    expect(svc.list(A2).skills[0]!.enabled).toBe(true);
    svc.setEnabled(A1, "mac", true);
    expect(svc.list(A1).skills[0]!.enabled).toBe(true);
  });

  it("demote pins the skill to one space, preserving that space's enable state", () => {
    const svc = scoped();
    skill(svc.root, "mac");
    svc.promote(A1, "mac");
    svc.setEnabled(A2, "mac", false);
    svc.demote(A2, "mac");
    // A2 keeps its (disabled) state; A1 — a sibling — stops seeing it entirely.
    expect(svc.list(A2).skills.map((x) => [x.id, x.enabled])).toEqual([["mac", false]]);
    expect(svc.list(A1).skills).toEqual([]);
    expect(svc.list(A2).skills[0]!.scope).toEqual({ kind: "space", spaceId: A2 });
  });

  it("refuses scope moves that make no sense, with a code a client can act on", () => {
    const svc = scoped();
    skill(svc.root, "mac");
    expect(() => svc.demote(A1, "mac")).toThrow(RpcError);              // not profile-scoped yet
    expect(() => svc.promote(A1, "ghost")).toThrow(RpcError);           // not in the library
    svc.promote(A1, "mac");
    expect(() => svc.promote(A1, "mac")).toThrow(RpcError);             // already profile-scoped
    expect(() => svc.demote(B1, "mac")).toThrow(RpcError);              // B1 is not in PA
    svc.demote(A2, "mac");
    expect(() => svc.promote(A1, "mac")).toThrow(RpcError);             // now defined in A2, not A1
    expect(() => svc.promote(B1, "mac")).toThrow(RpcError);
  });

  it("stages exactly the effective set: a profile skill of PA never reaches a PB session", () => {
    // `injectionFor` consumes `list()` — this is the wire-side half of the leak mutant: the staged
    // library an agent actually reads must agree with what the panel showed.
    const svc = scoped();
    skill(svc.root, "mac");
    svc.promote(A1, "mac");
    expect(svc.wouldInject(A2, "claude")).toBe(true);
    expect(staged(svc.injectionFor(A2, "claude")!)).toEqual(["mac"]);
    expect(svc.wouldInject(B1, "claude")).toBe(false);
    expect(svc.injectionFor(B1, "claude")).toBeNull();
  });
});

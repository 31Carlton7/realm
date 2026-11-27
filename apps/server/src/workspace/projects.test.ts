import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { SessionEvent } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db/database";
import { openDatabase } from "../db/database";
import { BrowserPermissionBroker } from "../browsers/permissions";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { ProjectsStore } from "../store/projects";
import { EnvironmentsStore } from "../store/environments";
import type { WorkspaceToolGroup } from "./agent-tools";
import { openProject } from "./open-project";
import { createProjectTools } from "./projects";

/**
 * `project_list`, `project_link` and `project_unlink` over the real stores, `openProject` and the real
 * permission broker, with real folders under a scratch home. Only the session and the person's answer
 * to a card are stand-ins.
 *
 * The named mutants:
 *
 *   - the person's-turn check dropped (link or unlink) → "refuses both in a turn the person did not start"
 *   - link's card dropped                              → "asks before linking, unless the session is on Full access"
 *   - unlink's card skipped on Full access             → "asks before unlinking even on Full access"
 *   - `pickFolder` bypassed                            → "refuses a folder that holds keys"
 *   - another profile's space reached                  → "reaches only this profile's spaces"
 */

let db: Db;
let home: string;
let repo: string;
let spaceId: string;
let otherSpaceId: string;
let foreignSpaceId: string;
let projects: ProjectsStore;
let environments: EnvironmentsStore;
let tools: WorkspaceToolGroup;
let personTurn: boolean;
let mode: string;
let answer: "allow" | "deny";
let cards: { toolName: string; title: string }[];
let broadcasts: string[];

beforeEach(() => {
  home = realpathSync(tempDir("realm-project-tools-"));
  const realmHome = join(home, "Realm");
  repo = join(home, "code", "stora");
  mkdirSync(realmHome, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, ".ssh"));
  db = openDatabase(join(realmHome, "realm.db"));
  const profiles = new ProfilesStore(db);
  const spaces = new SpacesStore(db, realmHome);
  const me = profiles.create({ name: "P", icon: "x", color: "#000" }).id;
  const someoneElse = profiles.create({ name: "Q", icon: "x", color: "#000" }).id;
  spaceId = spaces.create({ profileId: me, name: "Stora", icon: "folder" }).id;
  otherSpaceId = spaces.create({ profileId: me, name: "Versed", icon: "folder" }).id;
  foreignSpaceId = spaces.create({ profileId: someoneElse, name: "Taxes", icon: "folder" }).id;
  projects = new ProjectsStore(db);
  environments = new EnvironmentsStore(db);
  personTurn = true;
  mode = "default";
  answer = "allow";
  cards = [];
  broadcasts = [];
  const broker: BrowserPermissionBroker = new BrowserPermissionBroker({
    permissionMode: () => mode,
    emit: (_id: string, ev: SessionEvent) => {
      if (ev.type !== "permission_request") return;
      const p = ev.payload as { requestId: string; toolName: string; title: string };
      cards.push({ toolName: p.toolName, title: p.title });
      queueMicrotask(() => broker.resolve(p.requestId, answer));
    },
  });
  tools = createProjectTools({
    spaces, projects, broker, rpc: { broadcast: (event: string) => { broadcasts.push(event); } }, userHome: home, realmHome,
    sessions: { personStartedTurn: () => personTurn },
    turnOrigin: () => "a message from @polish",
    open: (input) => openProject({ profiles, spaces, projects, environments }, input),
  });
});

afterEach(() => { db.close(); });

const call = (tool: string, args: unknown) => tools.handlers[tool]!({ sessionId: "sess-1", spaceId }, args);
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("project_link", () => {
  it("attaches the folder with its checkout, so the workspace selector offers it, and lists it", async () => {
    const res = await call("project_link", { path: "~/code/stora" });
    expect(res.isError).toBe(false);
    const [project] = projects.list(spaceId);
    expect(project).toMatchObject({ name: "stora", rootPath: repo });
    expect(environments.list(spaceId).map((e) => [e.path, e.kind])).toContainEqual([repo, "checkout"]);
    expect(broadcasts).toEqual(["items.changed", "environments.changed"]);
    expect(text(res)).toContain(`projectId ${project!.id}`);
    expect(text(await call("project_list", {}))).toContain(`- stora — projectId ${project!.id}, ${repo}`);
  });

  it("asks before linking, unless the session is on Full access, and links nothing when told no", async () => {
    answer = "deny";
    const denied = await call("project_link", { path: repo });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("the user denied this action");
    expect(cards).toEqual([{ toolName: "project_link", title: `Link ${repo} to the space "Stora"` }]);
    expect(projects.list(spaceId)).toEqual([]);
    mode = "bypassPermissions";
    expect((await call("project_link", { path: repo })).isError).toBe(false);
    expect(cards).toHaveLength(1);
    expect(projects.list(spaceId)).toHaveLength(1);
  });

  it("refuses a folder that holds keys, and one that is not there", async () => {
    const keys = await call("project_link", { path: "~/.ssh" });
    expect(keys.isError).toBe(true);
    expect(text(keys)).toContain("which holds keys and credentials. Nothing was linked.");
    expect((await call("project_link", { path: join(home, "nowhere") })).isError).toBe(true);
    expect((await call("project_link", { path: "code/stora" })).isError).toBe(true);
    expect(projects.list(spaceId)).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("changes nothing for a folder the space already has", async () => {
    await call("project_link", { path: repo });
    const again = await call("project_link", { path: repo });
    expect(again.isError).toBe(false);
    expect(text(again)).toContain("already has");
    expect(projects.list(spaceId)).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });

  it("links into another space of this profile, and none of another profile's", async () => {
    expect((await call("project_link", { path: repo, spaceId: otherSpaceId })).isError).toBe(false);
    expect(projects.list(otherSpaceId)).toHaveLength(1);
    const foreign = await call("project_link", { path: repo, spaceId: foreignSpaceId });
    expect(foreign.isError).toBe(true);
    expect(text(foreign)).toContain("no space");
    expect(projects.list(foreignSpaceId)).toEqual([]);
    expect((await call("project_list", { spaceId: foreignSpaceId })).isError).toBe(true);
  });
});

describe("project_unlink", () => {
  it("asks before unlinking even on Full access, and leaves the folder's checkout", async () => {
    mode = "bypassPermissions";
    await call("project_link", { path: repo });
    const [project] = projects.list(spaceId);
    answer = "deny";
    expect((await call("project_unlink", { projectId: project!.id })).isError).toBe(true);
    expect(projects.list(spaceId)).toHaveLength(1);
    expect(cards).toEqual([{ toolName: "project_unlink", title: `Unlink the project stora (${repo}) from "Stora"` }]);
    answer = "allow";
    expect((await call("project_unlink", { projectId: project!.id })).isError).toBe(false);
    expect(projects.list(spaceId)).toEqual([]);
    expect(environments.list(spaceId).map((e) => e.path)).toContain(repo);
  });

  it("reaches only this profile's projects", async () => {
    const foreign = projects.create({ spaceId: foreignSpaceId, name: "taxes", rootPath: repo, defaultBranch: "main" });
    const res = await call("project_unlink", { projectId: foreign.id });
    expect(res.isError).toBe(true);
    expect(projects.get(foreign.id)).not.toBeNull();
    expect(cards).toEqual([]);
  });
});

describe("in a turn the person did not start", () => {
  it("refuses both, naming who started the turn, and changes nothing", async () => {
    const linked = projects.create({ spaceId, name: "stora", rootPath: repo, defaultBranch: "main" });
    personTurn = false;
    const link = await call("project_link", { path: repo, spaceId: otherSpaceId });
    expect(text(link)).toBe("refused: this turn was started by a message from @polish, not by the person. Projects are linked only in a turn the person started; ask them to say it in this chat. Nothing was linked.");
    const unlink = await call("project_unlink", { projectId: linked.id });
    expect(unlink.isError).toBe(true);
    expect(text(unlink)).toContain("Projects are unlinked only in a turn the person started");
    expect(projects.list(otherSpaceId)).toEqual([]);
    expect(projects.get(linked.id)).not.toBeNull();
    expect(cards).toEqual([]);
  });
});

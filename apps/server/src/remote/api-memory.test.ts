import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { memoryLearningKey } from "@realm/contracts";
import { MEMORY_PAGE_MAX, MEMORY_PLACE_HEAD, MEMORY_ROW_TEXT_MAX, MEMORY_TEXT_MAX, MobileCalls, type MobileMethod } from "@realm/remote";
import { createApp, type App } from "../app";
import { MobileApi, MobileError } from "./api";
import { channel } from "./api.test-fakes";
import { RpcCallError, type RpcPort } from "./rpc-port";

/**
 * The memory library as a phone reads and changes it, against a real Mac: the same repo, the same
 * commits, and what is refused or left out however it is asked for.
 */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

async function rpcOf(port: number): Promise<RpcPort> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (m: { result?: unknown; error?: { code: string; message: string } }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  return {
    call: (method: string, params: unknown) => new Promise((res, rej) => {
      const id = String(++n);
      pending.set(id, (m) => (m.error ? rej(new RpcCallError(m.error.code, m.error.message)) : res(m.result as never)));
      ws.send(JSON.stringify({ id, method, params }));
    }),
  } as RpcPort;
}

/** A Mac with one profile, two spaces, its memory repo, and Claude's and a space's own files. */
async function mac() {
  const scratch = tempDir("realm-api-memory-");
  const user = join(scratch, "user");
  mkdirSync(join(user, ".claude"), { recursive: true });
  writeFileSync(join(user, ".claude", "CLAUDE.md"), "# House rules\n\nSpeak plainly.\n");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(scratch, "no-bundle"));
  const home = join(scratch, "realm");
  mkdirSync(home);
  app = await createApp({ home, port: 0, userHome: user, claudeDir: join(user, ".claude"), memoryRepoByDefault: true, claudeTemporaryRoots: [] });
  const rpc = await rpcOf(app.port);
  const [profile] = await rpc.call("profiles.list", {});
  const realm = await rpc.call("spaces.create", { profileId: profile!.id, name: "Realm" });
  const survey = await rpc.call("spaces.create", { profileId: profile!.id, name: "Glacier" });
  const { root } = await rpc.call("documents.spaceRoot", { spaceId: survey.id });
  writeFileSync(join(root, "CLAUDE.md"), "# Glacier rules\n\nRead stakes weekly.\n");
  const profileId = profile!.id;
  const sourceId = `realm-repo-profile-${profileId}`;
  const repo = join(home, "memory", "repos", `profile-${profileId}`);
  const phone = new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: home, dev: false });
  const ask = async <M extends MobileMethod>(method: M, params: unknown) => MobileCalls[method].result.parse(await phone.handle(channel(rpc), method, params)) as never;
  const refusal = async (method: MobileMethod, params: unknown): Promise<MobileError> => {
    try { await phone.handle(channel(rpc), method, params); } catch (e) { if (e instanceof MobileError) return e; throw e; }
    throw new Error(`${method} was not refused`);
  };
  return { rpc, ask, refusal, profileId, sourceId, repo, user, realmId: realm.id as string, surveyId: survey.id as string };
}

type Overview = { places: { id: string; kind: string; spaceId: string | null; title: string; count: number; entries: { id: string; title: string; description: string | null; source: string; match: string | null }[] }[]; homes: { sourceId: string; spaceId: string | null; label: string }[]; learning: boolean };
type Page = { entries: { id: string; title: string; description: string | null; match: string | null }[]; total: number; next: number | null };
type File = { id: string; title: string; text: string; body: string; external: boolean; writable: boolean; deletable: boolean; updatedAt: number; note: string | null; displayPath: string; source: string };

describe("memory.overview", () => {
  it("groups memories by who they are for, and offers where a new one can go", async () => {
    const m = await mac();
    await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Ships Fridays", description: "When releases go out", type: "project", body: "Fridays." });
    await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, spaceId: m.realmId, name: "Uses pnpm", description: "The package manager", type: "reference", body: "pnpm." });
    await m.rpc.call("memory.set", { spaceId: m.surveyId, doc: "Stakes are read weekly.\n" });
    const got: Overview = await m.ask("memory.overview", { profileId: m.profileId });
    expect(got.places.map((p) => [p.id, p.kind, p.title])).toEqual([
      [`every:${m.profileId}`, "every", "Every space"],
      [`space:${m.realmId}`, "space", "Realm"],
      [`space:${m.surveyId}`, "space", "Glacier"],
      ["agent:claude", "agent", "Claude"],
    ]);
    const titles = (id: string) => got.places.find((p) => p.id === id)!.entries.map((e) => e.title);
    expect(titles(`every:${m.profileId}`)).toContain("Ships Fridays");
    expect(titles(`space:${m.realmId}`)).toContain("Uses pnpm");
    expect(titles(`space:${m.surveyId}`)).toEqual(expect.arrayContaining(["Glacier", "Glacier rules"]));
    expect(titles("agent:claude")).toEqual(["House rules"]);
    expect(got.places.find((p) => p.id === "agent:claude")!.entries[0]!.source).toBe("Claude · User memory");
    expect(got.homes).toEqual([
      { sourceId: m.sourceId, spaceId: null, label: "Memory repo · every space" },
      { sourceId: m.sourceId, spaceId: m.realmId, label: "Memory repo · Realm" },
      { sourceId: m.sourceId, spaceId: m.surveyId, label: "Memory repo · Glacier" },
    ]);
  });

  it("sends each place's newest few and never a path", async () => {
    const m = await mac();
    for (let i = 0; i < MEMORY_PLACE_HEAD + 3; i++) {
      await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: `Fact ${i}`, description: "x".repeat(400), type: "project", body: "." });
    }
    const raw = await m.ask("memory.overview", { profileId: m.profileId });
    expect(JSON.stringify(raw)).not.toContain(m.repo);
    expect(JSON.stringify(raw)).not.toContain(m.user);
    const every = (raw as Overview).places[0]!;
    expect(every.entries).toHaveLength(MEMORY_PLACE_HEAD);
    expect(every.count).toBeGreaterThan(MEMORY_PLACE_HEAD);
    const fact = every.entries.find((e) => e.title.startsWith("Fact"))!;
    expect(fact.description!.length).toBeLessThanOrEqual(MEMORY_ROW_TEXT_MAX);
  });
});

describe("memory.list", () => {
  it("pages a place, and refuses a page larger than a phone may ask for", async () => {
    const m = await mac();
    for (const i of [1, 2, 3]) await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, spaceId: m.realmId, name: `Note ${i}`, description: "d", type: "project", body: "." });
    const place = `space:${m.realmId}`;
    const first: Page = await m.ask("memory.list", { profileId: m.profileId, place, limit: 2 });
    const second: Page = await m.ask("memory.list", { profileId: m.profileId, place, offset: first.next, limit: 100 });
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBe(2);
    expect(second.next).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(first.total);
    expect((await m.refusal("memory.list", { profileId: m.profileId, limit: MEMORY_PAGE_MAX + 1 })).code).toBe("INVALID_PARAMS");
  });

  it("searches names, descriptions and bodies, with the best line", async () => {
    const m = await mac();
    await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Release day", description: "When we ship", type: "project", body: "The melt report goes out on Friday." });
    const byBody: Page = await m.ask("memory.list", { profileId: m.profileId, query: "melt report" });
    expect(byBody.entries[0]).toMatchObject({ title: "Release day" });
    expect(byBody.entries[0]!.match).toContain("melt report");
    await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Links", description: "d", type: "project", body: "- See [the field guide](guide.md) and [[stakes]]." });
    const linked: Page = await m.ask("memory.list", { profileId: m.profileId, query: "field guide" });
    expect(linked.entries.find((e) => e.title === "Links")!.match).toBe("See the field guide and stakes.");
    const typing: Page = await m.ask("memory.list", { profileId: m.profileId, query: "relea" });
    expect(typing.entries.map((e) => e.title)).toContain("Release day");
    expect(((await m.ask("memory.list", { profileId: m.profileId, query: "nothing like this" })) as Page).entries).toEqual([]);
  });
});

describe("memory.file", () => {
  it("reads a file a source lists, and nothing else", async () => {
    const m = await mac();
    const file: File = await m.ask("memory.file", { id: "claude-user:CLAUDE.md", profileId: m.profileId });
    expect(file).toMatchObject({ title: "House rules", external: true, writable: true, deletable: true, displayPath: "~/.claude/CLAUDE.md", source: "Claude · User memory" });
    expect(file.body).toContain("Speak plainly.");
    writeFileSync(join(m.user, "private.md"), "not memory\n");
    for (const id of ["claude-user:../private.md", "claude-user:private.md", "nope:CLAUDE.md", "claude-user:.git/config"]) {
      expect((await m.refusal("memory.file", { id, profileId: m.profileId })).code).toBe("NOT_FOUND");
    }
  });

  it("does not send a file that holds a secret, and its row says nothing of it", async () => {
    const m = await mac();
    const token = `sk-${"a1B2".repeat(10)}`;
    writeFileSync(join(m.user, ".claude", "CLAUDE.md"), `---\ndescription: The key is ${token}\n---\n\nUse ${token} for the API.\n`);
    const refused = await m.refusal("memory.file", { id: "claude-user:CLAUDE.md", profileId: m.profileId });
    expect(refused.code).toBe("FORBIDDEN");
    expect(refused.message).toContain("does not send it to a phone");
    const overview = await m.ask("memory.overview", { profileId: m.profileId });
    expect(JSON.stringify(overview)).not.toContain(token);
    const searched = await m.ask("memory.list", { profileId: m.profileId, query: "API" });
    expect(JSON.stringify(searched)).not.toContain(token);
  });

  it("does not list or send a file in a folder that holds secrets, whatever its name", async () => {
    const m = await mac();
    mkdirSync(join(m.repo, ".ssh"));
    writeFileSync(join(m.repo, ".ssh", "notes.md"), "# Server keys\n\nThe bastion's address.\n");
    const listed = await m.ask("memory.list", { profileId: m.profileId });
    expect(JSON.stringify(listed)).not.toContain("Server keys");
    expect((await m.refusal("memory.file", { id: `${m.sourceId}:.ssh/notes.md`, profileId: m.profileId })).code).toBe("FORBIDDEN");
  });

  it("does not send the whole of a file past what a phone edits, and will not take it back", async () => {
    const m = await mac();
    writeFileSync(join(m.user, ".claude", "CLAUDE.md"), `# Long\n\n${"x".repeat(MEMORY_TEXT_MAX + 10)}\n`);
    const file: File = await m.ask("memory.file", { id: "claude-user:CLAUDE.md", profileId: m.profileId });
    expect(file.writable).toBe(false);
    expect(file.text).toBe("");
    expect(file.body.length).toBeLessThanOrEqual(MEMORY_TEXT_MAX);
    expect(file.note).toContain("on your Mac");
  });
});

describe("memory.write", () => {
  it("saves into the repo as one commit", async () => {
    const m = await mac();
    const made: File = await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Ships Fridays", description: "When", type: "project", body: "Fridays." });
    const commits = () => execFileSync("git", ["-C", m.repo, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    const before = commits().length;
    const text = made.text.replace("Fridays.", "Thursdays now.");
    const saved: File = await m.ask("memory.write", { id: made.id, profileId: m.profileId, text, baseUpdatedAt: made.updatedAt });
    expect(saved.body).toContain("Thursdays now.");
    expect(readFileSync(join(m.repo, "ships-fridays.md"), "utf8")).toContain("Thursdays now.");
    expect(commits()).toHaveLength(before + 1);
    expect(commits()[0]).toBe("Update ships-fridays.md");
  });

  it("will not write a file outside Realm without the person's yes", async () => {
    const m = await mac();
    const claude = join(m.user, ".claude", "CLAUDE.md");
    const refused = await m.refusal("memory.write", { id: "claude-user:CLAUDE.md", profileId: m.profileId, text: "# Mine\n" });
    expect(refused.code).toBe("FORBIDDEN");
    expect(readFileSync(claude, "utf8")).toContain("House rules");
    await m.ask("memory.write", { id: "claude-user:CLAUDE.md", profileId: m.profileId, text: "# Mine\n", confirmExternal: true });
    expect(readFileSync(claude, "utf8")).toBe("# Mine\n");
  });

  it("does not overwrite what changed after the phone read it", async () => {
    const m = await mac();
    const made: File = await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Moving target", description: "d", type: "project", body: "One." });
    await m.ask("memory.write", { id: made.id, profileId: m.profileId, text: made.text.replace("One.", "An agent's two.") });
    const refused = await m.refusal("memory.write", { id: made.id, profileId: m.profileId, text: made.text.replace("One.", "Phone's three."), baseUpdatedAt: made.updatedAt - 1 });
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("changed on your Mac") });
    expect(readFileSync(join(m.repo, "moving-target.md"), "utf8")).toContain("An agent's two.");
  });

  it("refuses a key in a repo's memory, in the Mac's words", async () => {
    const m = await mac();
    const made: File = await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Clean", description: "d", type: "project", body: "Clean." });
    const refused = await m.refusal("memory.write", { id: made.id, profileId: m.profileId, text: `${made.text}\nsk-${"a1B2".repeat(10)}\n` });
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("memory never holds credentials") });
  });
});

describe("memory.create", () => {
  it("refuses a second memory of the same name", async () => {
    const m = await mac();
    await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Once", description: "d", type: "user", body: "." });
    const refused = await m.refusal("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Once", description: "d", type: "user", body: "." });
    expect(refused).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("already") });
    expect((await m.refusal("memory.create", { profileId: m.profileId, sourceId: "claude-user", name: "Nope", description: "d", type: "user", body: "." })).code).toBe("FORBIDDEN");
  });
});

describe("memory.delete", () => {
  it("removes a repo's memory and its index line in a commit", async () => {
    const m = await mac();
    const made: File = await m.ask("memory.create", { profileId: m.profileId, sourceId: m.sourceId, name: "Short lived", description: "d", type: "project", body: "." });
    expect(readFileSync(join(m.repo, "MEMORY.md"), "utf8")).toContain("short-lived");
    expect(await m.ask("memory.delete", { id: made.id })).toEqual({ trashed: false });
    expect(existsSync(join(m.repo, "short-lived.md"))).toBe(false);
    expect(readFileSync(join(m.repo, "MEMORY.md"), "utf8")).not.toContain("short-lived");
    expect(execFileSync("git", ["-C", m.repo, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("Forget short-lived.md");
    expect((await m.refusal("memory.delete", { id: made.id })).code).toBe("NOT_FOUND");
  });

  it("refuses what the desktop refuses to delete", async () => {
    const m = await mac();
    await m.rpc.call("memory.set", { spaceId: m.surveyId, doc: "A document.\n" });
    const claude = join(m.user, ".claude", "CLAUDE.md");
    expect((await m.refusal("memory.delete", { id: "claude-user:CLAUDE.md" })).code).toBe("FORBIDDEN");
    expect(existsSync(claude)).toBe(true);
    expect((await m.refusal("memory.delete", { id: `${m.sourceId}:MEMORY.md` })).code).toBe("FORBIDDEN");
    expect((await m.refusal("memory.delete", { id: `realm-docs-${m.profileId}:${m.surveyId}.md` })).code).toBe("FORBIDDEN");
  });
});

describe("memory.setLearning", () => {
  it("is the desktop's switch: on until it is turned off", async () => {
    const m = await mac();
    expect(((await m.ask("memory.overview", { profileId: m.profileId })) as Overview).learning).toBe(true);
    expect(await m.ask("memory.setLearning", { profileId: m.profileId, on: false })).toEqual({ on: false });
    expect((await m.rpc.call("settings.get", { key: memoryLearningKey(m.profileId) })).value).toBe(false);
    expect(((await m.ask("memory.overview", { profileId: m.profileId })) as Overview).learning).toBe(false);
  });
});

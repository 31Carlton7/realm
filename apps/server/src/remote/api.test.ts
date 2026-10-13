import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { sessionEvent, type FileDiff, type MethodName, type StoredSessionEvent, type TurnChanges } from "@realm/contracts";
import { HomeSchema, MobileCalls } from "@realm/remote";
import { needsYou } from "@realm/view";
import { ICON_MAX_BYTES, MobileApi, MobileError, needsYouInput } from "./api";
import { channel, fakeRpc, item, session, space, type Lists } from "./api.test-fakes";
import { DIFF_PAGE_BYTES } from "./changes";
import { PREVIEW_MAX_BYTES, TEXT_HEAD_BYTES, type Downscale } from "./preview";
import type { RpcPort } from "./rpc-port";

/**
 * mobile.v1's `home.get` against a fake of the desktop's RPC. Needs you is `@realm/view`'s rule; what
 * is the server's own, and so what these hold, is the input it builds for that rule from its lists.
 */

const api = (downscale?: Downscale) => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", dev: false, downscale });
const home = async (h: Lists) => HomeSchema.parse(await api().handle(channel(fakeRpc(h)), "home.get", {}));

describe("home.get's Needs you is the sidebar's", () => {
  /** Every case the rule decides, as the desktop's lists would carry it. */
  const lists: Lists = {
    sessions: [
      session("asks", "s1", { status: "waiting_permission", updatedAt: 300, createdAt: 900, activityAt: 900 }),
      session("permits", "s2", { status: "waiting_permission", updatedAt: 100, createdAt: 800, activityAt: 950 }),
      session("lead", "s1", { updatedAt: 5 }),
      session("child-of-listed", "s1", { status: "waiting_permission", updatedAt: 50, dispatchedBy: { kind: "agent_run", sessionId: "lead" } }),
      session("put-away-lead", "s1", { updatedAt: 6 }),
      session("child-of-put-away", "s1", { status: "waiting_permission", updatedAt: 200, dispatchedBy: { kind: "agent_run", sessionId: "put-away-lead" } }),
      session("quick", "s1", { status: "waiting_permission", updatedAt: 10 }),
      session("failed-unread", "s1", { status: "error", lastEventSeq: 9, seenSeq: 4, updatedAt: 700 }),
      session("failed-read", "s1", { status: "error", lastEventSeq: 9, seenSeq: 9, updatedAt: 600 }),
      session("failed-archived", "s2", { status: "error", lastEventSeq: 9, updatedAt: 500 }),
      session("failed-never-opened", "s2", { status: "error", lastEventSeq: 3, updatedAt: 400 }),
      session("running", "s1", { status: "running", updatedAt: 1 }),
    ],
    items: [
      item("asks", "s1", "Asks a question"), item("permits", "s2", "Wants to run a command"), item("lead", "s1", "Lead"),
      item("child-of-listed", "s1", "Child of a listed lead"), item("put-away-lead", "s1", "Put away", { archived: true }),
      item("child-of-put-away", "s1", "Child of a put-away lead"),
      item("failed-unread", "s1", "Failed, unread"), item("failed-read", "s1", "Failed, read"), item("failed-archived", "s2", "Failed, archived", { archived: true }),
      item("failed-never-opened", "s2", "Failed, never opened"), item("running", "s1", "Running"),
    ],
    settings: { "ui.quickChat": { sessionId: "quick", pos: null } },
  };

  it("lists the waiting by how long each has waited, then the failures nobody has read, and nothing else", async () => {
    const h = await home(lists);
    // THE MUTANTS, each a one-line change to the input `needsYouInput` builds:
    //  - `quickChatId: null`              → the quick chat's question is listed;
    //  - `sessionUpdatedAt: …createdAt`   → the order is the order they were made;
    //  - `allItems: []`                   → no failure has a row to be listed by, and every lead is unlisted.
    expect(h.needsYou.map((r) => r.id)).toEqual(["permits", "child-of-put-away", "asks", "failed-never-opened", "failed-unread"]);
    expect(h.needsYou.map((r) => [r.title, r.spaceName, r.status])).toEqual([
      ["Wants to run a command", "Space s2", "waiting"], ["Child of a put-away lead", "Space s1", "waiting"], ["Asks a question", "Space s1", "waiting"],
      ["Failed, never opened", "Space s2", "error"], ["Failed, unread", "Space s1", "error"],
    ]);
  });

  it("is exactly what the sidebar's rule makes of the same lists", async () => {
    const h = await home(lists);
    const all = lists.sessions;
    const expected = needsYou(needsYouInput({ spaces: [space("s1"), space("s2", "p2")], sessions: all, items: lists.items.filter((i) => !i.archived), quickChatId: "quick" }));
    expect(h.needsYou.map((r) => r.id)).toEqual(expected.map((r) => r.session.id));
  });

  it("marks a row as needing you exactly when Needs you lists it", async () => {
    const h = await home(lists);
    const listed = new Set(h.needsYou.map((r) => r.id));
    const rows = h.spaces.flatMap((sp) => sp.sessions);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of [...rows, ...h.needsYou]) expect(r.needsYou, r.id).toBe(listed.has(r.id));
    // The quick chat waits, yet it is no row of Needs you, so it does not say it needs you either.
    expect(rows.find((r) => r.id === "quick")).toBeUndefined();
  });

  it("reads the quick chat's session from its window's setting, and leaves the rest when there is none", async () => {
    const none = await home({ ...lists, settings: {} });
    expect(none.needsYou.map((r) => r.id)).toContain("quick");
    const gone = await home({ ...lists, settings: { "ui.quickChat": { sessionId: null, pos: { x: 1, y: 1 } } } });
    expect(gone.needsYou.map((r) => r.id)).toContain("quick");
  });
});

/** What a call answered, or the mobile.v1 error it refused with. */
async function attempt(a: MobileApi, rpc: RpcPort, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
  try { return { ok: true, result: await a.handle(channel(rpc), method, params) }; }
  catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
}

let seq = 0;
const stored = (sessionId: string, ev: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq: ++seq, sessionId, event: ev });

/** `sessions.events` as the server answers it: one session's own events, of the kinds asked for. */
const eventsOf = (log: StoredSessionEvent[]) => (p: { id: string; types?: string[] }) => {
  if (!log.some((e) => e.sessionId === p.id) && p.id !== "known") throw Object.assign(new Error(`session ${p.id}`), { name: "NotFound" });
  return log.filter((e) => e.sessionId === p.id && (!p.types || p.types.includes(e.event.type)));
};

describe("session.answer", () => {
  it("hands the desktop's answer shape on as it came: several picks as a list, words of your own as they were typed", async () => {
    const answered: unknown[] = [];
    const rpc = fakeRpc({ sessions: [], items: [] }, { "sessions.respondPermission": (p: never) => { answered.push(p); return { ok: true }; } });
    await api().handle(channel(rpc), "session.answer", { id: "s1", requestId: "r1", decision: "allow", answers: { labels: ["bug", "my own"], team: "eng", token: "tok_live_123" } });
    // THE MUTANT: join a list into one string, as the Phase 1 phone did — a multi-select whose options
    // allow nothing of your own then loses every pick (`normalizeAnswers` matches values whole).
    expect(answered).toEqual([{ id: "s1", requestId: "r1", decision: "allow", answers: { labels: ["bug", "my own"], team: "eng", token: "tok_live_123" } }]);
    // An older phone's answer, one label per question, still goes.
    await api().handle(channel(rpc), "session.answer", { id: "s1", requestId: "r2", decision: "allow", answers: { "Which database?": "SQLite" } });
    expect(answered[1]).toMatchObject({ answers: { "Which database?": "SQLite" } });
  });
});

describe("a session row's agent, model and space, as the desktop names them", () => {
  it("names the agent and its model, and reads each space's icon", async () => {
    const h = HomeSchema.parse(await api().handle(channel(fakeRpc({
      spaces: [{ ...space("s1"), icon: "emoji:🌊" }, { ...space("s2"), icon: "code" }, { ...space("s3"), icon: "asset:01JASSET" }],
      sessions: [
        session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5", updatedAt: 3 }),
        session("default", "s1", { agentKind: "claude", model: null, updatedAt: 2 }),
        session("luna", "s2", { agentKind: "codex", model: "gpt-6-luna", updatedAt: 1 }),
      ],
      items: [item("opus", "s1", "Opus"), item("default", "s1", "Default"), item("luna", "s2", "Luna")],
    }, { "agents.probe": () => [{ kind: "codex", available: true, version: "1", loggedIn: true, reason: null, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] }] })), "home.get", {}));
    const rows = h.spaces.flatMap((sp) => sp.sessions);
    expect(rows.map((r) => [r.id, r.agentName, r.agentMark, r.modelLabel])).toEqual([
      ["opus", "Claude", "claude", "Opus 5.5"], ["default", "Claude", "claude", "Fable 5.1"], ["luna", "Codex", "openai", "GPT-6 Luna"],
    ]);
    expect(h.spaces.map((sp) => [sp.iconKind, sp.emoji ?? sp.glyph ?? null])).toEqual([["emoji", "🌊"], ["glyph", "code"], ["picture", null]]);
  });

  it("does not wait on a probe that has never answered: the curated names, or the id itself", async () => {
    const never = new Promise<never>(() => {});
    const started = Date.now();
    const h = HomeSchema.parse(await api().handle(channel(fakeRpc({
      sessions: [session("luna", "s1", { agentKind: "codex", model: "gpt-6-luna" }), session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5" })],
      items: [item("luna", "s1", "Luna"), item("opus", "s1", "Opus")],
    }, { "agents.probe": () => never })), "home.get", {}));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.spaces[0]!.sessions.map((r) => r.modelLabel)).toEqual(["gpt-6-luna", "Opus 5.5"]);
  });
});

describe("space.icon", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const assets = (dataText: string, mime = "image/png") => () => [{ id: "01JASSET", profileId: "p1", kind: "upload", mime, dataText, prompt: null, createdAt: 0 }];
  const withIcon = (icon: string, more: Partial<Record<MethodName, (p: never) => unknown>>) => fakeRpc({ spaces: [{ ...space("s1"), icon }], sessions: [], items: [] }, more);

  it("sends a space's own picture, and nothing for a glyph or an emoji", async () => {
    const got = await attempt(api(), withIcon("asset:01JASSET", { "iconAssets.list": assets(`data:image/png;base64,${png.toString("base64")}`) }), "space.icon", { id: "s1" });
    expect(got).toEqual({ ok: true, result: { mime: "image/png", data: png.toString("base64") } });
    const svg = await attempt(api(), withIcon("asset:01JASSET", { "iconAssets.list": assets("<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml") }), "space.icon", { id: "s1" });
    expect(svg).toMatchObject({ ok: true, result: { mime: "image/svg+xml", data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") } });
    expect(await attempt(api(), withIcon("code", {}), "space.icon", { id: "s1" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), withIcon("asset:01JGONE", { "iconAssets.list": assets("data:image/png;base64,AA==") }), "space.icon", { id: "s1" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses a picture too large for a phone", async () => {
    const big = Buffer.alloc(ICON_MAX_BYTES + 1, 1).toString("base64");
    expect(await attempt(api(), withIcon("asset:01JASSET", { "iconAssets.list": assets(`data:image/png;base64,${big}`) }), "space.icon", { id: "s1" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("session.changes and session.diff", () => {
  const files: TurnChanges["files"] = [
    { path: "src/app.ts", oldPath: null, status: "modified", additions: 2, deletions: 1 },
    { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0 },
  ];
  const turn: TurnChanges = { checkpointId: "01JCHECKPOINT", settledAt: 5, root: "/repo", afterTree: "a".repeat(40), files, totalFiles: 2 };
  const log = [stored("s1", sessionEvent("turn_changes", turn)), stored("other", sessionEvent("turn_changes", { ...turn, checkpointId: "01JOTHER" }))];
  const patch = (lines: FileDiff["hunks"][number]["lines"]): FileDiff => ({
    path: "src/app.ts", oldPath: null, staged: false, binary: false, truncated: false, truncatedReason: null, additions: 2, deletions: 1,
    hunks: [{ header: "function main()", oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines }],
  });
  const rig = (diff: FileDiff) => {
    const asked: unknown[] = [];
    const rpc = fakeRpc({ sessions: [], items: [] }, { "sessions.events": eventsOf(log) as never, "checkpoints.turnDiff": (p: never) => { asked.push(p); return diff; } });
    return { rpc, asked };
  };

  it("lists the files a turn changed, from that session's own record of it", async () => {
    const { rpc } = rig(patch([]));
    expect(await attempt(api(), rpc, "session.changes", { id: "s1", checkpointId: "01JCHECKPOINT" })).toEqual({ ok: true, result: { checkpointId: "01JCHECKPOINT", files, totalFiles: 2 } });
    // Another session's turn is no turn of this one.
    expect(await attempt(api(), rpc, "session.changes", { id: "s1", checkpointId: "01JOTHER" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("serves a changed file's patch as a unified diff, between the trees the turn recorded", async () => {
    const { rpc, asked } = rig(patch([
      { kind: "context", text: "import x", oldLine: 1, newLine: 1 }, { kind: "del", text: "old()", oldLine: 2, newLine: null },
      { kind: "add", text: "new()", oldLine: null, newLine: 2 }, { kind: "add", text: "more()", oldLine: null, newLine: 3 }, { kind: "meta", text: "No newline at end of file", oldLine: null, newLine: null },
    ]));
    const got = await attempt(api(), rpc, "session.diff", { id: "s1", checkpointId: "01JCHECKPOINT", path: "src/app.ts" });
    expect(got).toMatchObject({ ok: true, result: { path: "src/app.ts", status: "modified", from: 0, next: null, total: 8, lines: [
      "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,2 +1,3 @@ function main()", " import x", "-old()", "+new()", "+more()", "\\ No newline at end of file",
    ] } });
    expect(MobileCalls["session.diff"].result.safeParse((got as { result: unknown }).result).success).toBe(true);
    expect(asked).toEqual([{ id: "01JCHECKPOINT", afterTree: turn.afterTree, path: "src/app.ts", oldPath: null }]);
  });

  it("refuses a path the turn did not change, and never asks git about it", async () => {
    const { rpc, asked } = rig(patch([]));
    // THE MUTANT: diff whatever path the phone names — then a phone reads any file in the repository.
    for (const path of ["src/secret.env", "/etc/passwd", "../src/app.ts", "src/old.ts"]) {
      expect(await attempt(api(), rpc, "session.diff", { id: "s1", checkpointId: "01JCHECKPOINT", path }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await attempt(api(), rpc, "session.diff", { id: "s1", checkpointId: "01JOTHER", path: "src/app.ts" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(asked).toEqual([]);
  });

  it("pages a long patch so that no answer nears the relay's 1 MiB, and the pages join into the whole", async () => {
    // 4,000 lines of 400 escaped control characters each — 2,400 bytes a line as JSON — and one line
    // far longer than a phone should be sent whole.
    const nasty = "\u0001".repeat(400);
    const lines = Array.from({ length: 4_000 }, (_, i) => ({ kind: "add" as const, text: i === 7 ? "x".repeat(50_000) : `${i}${nasty}`, oldLine: null, newLine: i + 1 }));
    const { rpc } = rig(patch(lines));
    const pages: string[][] = [];
    for (let from: number | null = 0; from !== null;) {
      const got = await attempt(api(), rpc, "session.diff", { id: "s1", checkpointId: "01JCHECKPOINT", path: "src/app.ts", from });
      if (!got.ok) throw new Error(got.message);
      const page = got.result as { lines: string[]; next: number | null; from: number; total: number };
      // THE MUTANT: send the whole patch in one answer — this one would be about 9.6 MB.
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(DIFF_PAGE_BYTES + 4_096);
      expect(page.from).toBe(pages.flat().length);
      pages.push(page.lines);
      from = page.next;
    }
    const all = pages.flat();
    expect(all).toHaveLength(4_003);
    expect(all[10]!.length).toBeLessThan(4_100);
    expect(all[10]).toMatch(/cut at 4000 characters\)$/);
    expect(all.at(-1)).toBe(`+3999${nasty}`);
  });
});

describe("session.file", () => {
  /** A session that made `made`, and a fake downscaler that records what it was asked to read. */
  function rig(made: { path: string; size: number }[], downscale?: Downscale) {
    const log = [stored("s1", sessionEvent("files_made", { settledAt: 1, files: made, totalFiles: made.length }))];
    return { rpc: fakeRpc({ sessions: [], items: [] }, { "sessions.events": eventsOf(log) as never }), a: api(downscale) };
  }

  it("previews only a file the session's turns made, and refuses every other path", async () => {
    const dir = tempDir("realm-made-");
    writeFileSync(join(dir, "made.md"), "# Notes\n");
    writeFileSync(join(dir, "beside.md"), "not made by the turn\n");
    const { rpc, a } = rig([{ path: join(dir, "made.md"), size: 8 }]);
    expect(await attempt(a, rpc, "session.file", { id: "s1", path: join(dir, "made.md") })).toMatchObject({ ok: true, result: { name: "made.md", preview: { kind: "text", text: "# Notes\n", truncated: false } } });
    // THE MUTANT: drop the check against `files_made`, and these are read like any other.
    for (const path of [join(dir, "beside.md"), "/etc/hosts", `${dir}/../${dir.split("/").at(-1)}/made.md`, join(dir, "made.md/..")]) {
      expect(await attempt(a, rpc, "session.file", { id: "s1", path }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    // Another session's files are not this one's.
    expect(await attempt(a, rpc, "session.file", { id: "other", path: join(dir, "made.md") })).toMatchObject({ ok: false });
  });

  it("refuses a listed path that has become a link, which could point anywhere", async () => {
    const dir = tempDir("realm-made-");
    writeFileSync(join(dir, "secret.txt"), "the key\n");
    symlinkSync(join(dir, "secret.txt"), join(dir, "shot.png"));
    const { rpc, a } = rig([{ path: join(dir, "shot.png"), size: 10 }], async () => { throw new Error("must not be read"); });
    expect(await attempt(a, rpc, "session.file", { id: "s1", path: join(dir, "shot.png") })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("sends the head of a long text, cut on a whole character, and says it was cut", async () => {
    const dir = tempDir("realm-made-");
    const body = `${"a".repeat(TEXT_HEAD_BYTES - 1)}é${"b".repeat(5_000)}`;
    writeFileSync(join(dir, "log.txt"), body);
    const { rpc, a } = rig([{ path: join(dir, "log.txt"), size: Buffer.byteLength(body) }]);
    const got = await attempt(a, rpc, "session.file", { id: "s1", path: join(dir, "log.txt") });
    expect(got).toMatchObject({ ok: true, result: { preview: { kind: "text", truncated: true } } });
    const text = ((got as { result: { preview: { text: string } } }).result.preview.text);
    // "é" is two bytes and straddles the cut: it is left out rather than sent half.
    expect(text).toBe("a".repeat(TEXT_HEAD_BYTES - 1));
  });

  it("sends a picture made smaller, at most PREVIEW_MAX_BYTES, and nothing for one that will not get that small", async () => {
    const dir = tempDir("realm-made-");
    writeFileSync(join(dir, "shot.png"), "png bytes");
    const asked: [string, number, number][] = [];
    const small: Downscale = async (path, px, q) => { asked.push([path, px, q]); return Buffer.from("jpeg"); };
    const one = rig([{ path: join(dir, "shot.png"), size: 9 }], small);
    expect(await attempt(one.a, one.rpc, "session.file", { id: "s1", path: join(dir, "shot.png") })).toMatchObject({ ok: true, result: { mime: "image/png", preview: { kind: "image", mime: "image/jpeg", data: Buffer.from("jpeg").toString("base64") } } });
    expect(asked).toEqual([[join(dir, "shot.png"), 1024, 70]]);
    const huge: Downscale = async () => Buffer.alloc(PREVIEW_MAX_BYTES + 1);
    const two = rig([{ path: join(dir, "shot.png"), size: 9 }], huge);
    expect(await attempt(two.a, two.rpc, "session.file", { id: "s1", path: join(dir, "shot.png") })).toMatchObject({ ok: true, result: { preview: { kind: "none" } } });
  });

  it("says a listed file that is gone is gone", async () => {
    const dir = tempDir("realm-made-");
    mkdirSync(join(dir, "sub"));
    const { rpc, a } = rig([{ path: join(dir, "gone.png"), size: 1 }, { path: join(dir, "sub"), size: 1 }]);
    expect(await attempt(a, rpc, "session.file", { id: "s1", path: join(dir, "gone.png") })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(a, rpc, "session.file", { id: "s1", path: join(dir, "sub") })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

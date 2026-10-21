import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import {
  AGENT_MODELS, PERMISSION_MODES, SELECTABLE_AGENT_KINDS, sessionEvent, steerNote, type FileDiff, type Item, type MethodName, type Session,
  type StoredSessionEvent, type TurnChanges,
} from "@realm/contracts";
import { HomeSchema, MobileCalls, RECENT_LIMIT, SEND_LIMITS } from "@realm/remote";
import { needsYou } from "@realm/view";
import { ICON_MAX_BYTES, MobileApi, MobileError, needsYouInput } from "./api";
import { channel, fakeRpc, item, profile, session, space, type Lists } from "./api.test-fakes";
import { DIFF_PAGE_BYTES } from "./changes";
import { PREVIEW_MAX_BYTES, TEXT_HEAD_BYTES, type Downscale } from "./preview";
import type { RpcPort } from "./rpc-port";

/**
 * mobile.v1's `home.get` against a fake of the desktop's RPC. Needs you is `@realm/view`'s rule; what
 * is the server's own, and so what these hold, is the input it builds for that rule from its lists.
 */

const api = (downscale?: Downscale, realmHome = "/nonexistent") => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome, dev: false, downscale });
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
        session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5", activityAt: 3 }),
        session("default", "s1", { agentKind: "claude", model: null, activityAt: 2 }),
        session("luna", "s2", { agentKind: "codex", model: "gpt-6-luna", activityAt: 1 }),
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
      sessions: [session("luna", "s1", { agentKind: "codex", model: "gpt-6-luna", activityAt: 2 }), session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5", activityAt: 1 })],
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

describe("home.get, one profile at a time", () => {
  /** `n` listed sessions in a space, each active an hour after the last from `from`. */
  const many = (n: number, spaceId: string, prefix: string, from: number): { sessions: Session[]; items: Item[] } => {
    const sessions = Array.from({ length: n }, (_, i) => session(`${prefix}${i}`, spaceId, { activityAt: from + i * 3_600_000 }));
    return { sessions, items: sessions.map((s) => item(s.id, spaceId, s.id)) };
  };
  const work = many(45, "s1", "work-", 1_000_000);
  const school = many(3, "s2", "school-", 200_000_000);
  const lists: Lists = {
    profiles: [profile("p1", "Work", "briefcase-01"), profile("p2", "School", "emoji:🎓"), profile("p3", "Personal", "asset:01JASSET")],
    spaces: [space("s1", "p1"), space("s2", "p2"), space("s3", "p3")],
    sessions: [
      ...work.sessions, ...school.sessions,
      session("asks", "s1", { status: "waiting_permission", updatedAt: 10 }), session("permits", "s1", { status: "waiting_permission", updatedAt: 20 }),
      session("failed", "s2", { status: "error", lastEventSeq: 9, updatedAt: 30 }),
      session("put-away", "s1", { activityAt: 999_999_999_999 }), session("quick", "s1", { activityAt: 999_999_999_998 }),
    ],
    items: [...work.items, ...school.items, item("asks", "s1", "Asks"), item("permits", "s1", "Permits"), item("failed", "s2", "Failed"),
      item("put-away", "s1", "Put away", { archived: true })],
    settings: { "ui.quickChat": { sessionId: "quick", pos: null } },
  };
  const get = async (params: unknown) => HomeSchema.parse(await api().handle(channel(fakeRpc(lists)), "home.get", params));

  it("lists every profile in the desktop's order, each with how many Needs you lists in it, its icon read", async () => {
    const h = await get({});
    // THE MUTANT: count Needs you across every profile, and each profile says 3.
    expect(h.profiles?.map((p) => [p.id, p.name, p.needsYou])).toEqual([["p1", "Work", 2], ["p2", "School", 1], ["p3", "Personal", 0]]);
    expect(h.profiles?.map((p) => [p.iconKind, p.glyph ?? p.emoji ?? null])).toEqual([["glyph", "briefcase-01"], ["emoji", "🎓"], ["picture", null]]);
    expect(h.spaces.map((sp) => sp.profileId)).toEqual(["p1", "p2", "p3"]);
  });

  it("gathers recent in the profile asked for, newest first and at most RECENT_LIMIT, and keeps Needs you every profile's", async () => {
    const h = await get({ profileId: "p1" });
    expect(h.profileId).toBe("p1");
    // THE MUTANTS: no cut (45 rows), oldest first, or every profile's sessions in the list.
    expect(h.recent).toHaveLength(RECENT_LIMIT);
    expect(h.recent!.map((r) => r.id)).toEqual(Array.from({ length: RECENT_LIMIT }, (_, i) => `work-${44 - i}`));
    expect(h.needsYou.map((r) => r.id)).toEqual(["asks", "permits", "failed"]);
    // What Home lists of each space is every profile's, as it was: the newest five, and how many more.
    expect(h.spaces.map((sp) => [sp.sessions.map((r) => r.id), sp.more])).toEqual([
      [["work-44", "work-43", "work-42", "work-41", "work-40"], 42], [["school-2", "school-1", "school-0", "failed"], 0], [[], 0],
    ]);
  });

  it("gathers recent from every profile without one, and for a profile the Mac no longer has, and says so", async () => {
    for (const params of [{}, { profileId: "01JGONEPROFILE000000000000" }]) {
      const h = await get(params);
      expect(h.profileId).toBeNull();
      expect(h.recent!.slice(0, 4).map((r) => r.id)).toEqual(["school-2", "school-1", "school-0", "work-44"]);
      // An archived session and the quick chat are no rows, however recent.
      expect(h.recent!.map((r) => r.id)).not.toContain("put-away");
      expect(h.recent!.map((r) => r.id)).not.toContain("quick");
    }
  });

  it("puts on every row when the session was made, and the reasoning level and permissions it was given", async () => {
    const h = HomeSchema.parse(await api().handle(channel(fakeRpc({
      sessions: [session("planning", "s1", { agentKind: "claude", createdAt: 77, effort: "xhigh", permissionMode: "plan" })],
      items: [item("planning", "s1", "Planning")],
    })), "home.get", {}));
    expect(h.recent?.[0]).toMatchObject({ id: "planning", createdAt: 77, effort: "xhigh", permissionMode: "plan" });
    expect(h.spaces[0]!.sessions[0]).toMatchObject({ createdAt: 77, effort: "xhigh", permissionMode: "plan" });
  });
});

describe("Home's order is the conversation's", () => {
  // `talked` moved last; `tweaked` was given another model since, and `seen` was read since: both rows
  // were written later than `talked`'s, and neither conversation moved.
  const lists: Lists = {
    sessions: [
      session("seen", "s1", { activityAt: 50, updatedAt: 950, lastEventSeq: 4, seenSeq: 4 }),
      session("tweaked", "s1", { activityAt: 100, updatedAt: 900, model: "fake" }),
      session("talked", "s1", { activityAt: 200, updatedAt: 100 }),
    ],
    items: [item("seen", "s1", "Seen"), item("tweaked", "s1", "Tweaked"), item("talked", "s1", "Talked")],
  };

  it("lists a space's few, recent and a space's pages by when each conversation last moved, and says when", async () => {
    const rpc = fakeRpc(lists);
    const h = HomeSchema.parse(await api().handle(channel(rpc), "home.get", {}));
    const page = MobileCalls["space.sessions"].result.parse(await api().handle(channel(rpc), "space.sessions", { id: "s1" }));
    // THE MUTANT: order by `updatedAt`, and a row moves up for having been read or set up again.
    for (const rows of [h.spaces[0]!.sessions, h.recent!, page.sessions]) expect(rows.map((r) => r.id)).toEqual(["talked", "tweaked", "seen"]);
    expect(h.recent!.map((r) => [r.activityAt, r.updatedAt])).toEqual([[200, 100], [100, 900], [50, 950]]);
  });

  it("breaks a tie by the newer session, then by id, whatever order the Mac's lists come in", async () => {
    const tied = (order: string[]) => fakeRpc({
      sessions: order.map((id) => session(id, "s1", { activityAt: 10, createdAt: id === "a" ? 2 : 1 })),
      items: order.map((id) => item(id, "s1", id)),
    });
    for (const order of [["b", "c", "a"], ["a", "c", "b"], ["c", "b", "a"]]) {
      const rpc = tied(order);
      const h = HomeSchema.parse(await api().handle(channel(rpc), "home.get", {}));
      // THE MUTANTS: no tie-break past `activityAt` (the lists' own order), or none past `createdAt`.
      expect(h.recent!.map((r) => r.id), order.join("")).toEqual(["a", "c", "b"]);
      const pages = [];
      for (let offset = 0; offset < 3; offset++) {
        pages.push(...MobileCalls["space.sessions"].result.parse(await api().handle(channel(rpc), "space.sessions", { id: "s1", offset, limit: 1 })).sessions.map((r) => r.id));
      }
      expect(pages).toEqual(["a", "c", "b"]);
    }
  });
});

describe("space.sessions", () => {
  const sessions = Array.from({ length: 7 }, (_, i) => session(`s1-${i}`, "s1", { activityAt: 100 + i }));
  const rpc = fakeRpc({
    sessions: [...sessions, session("archived", "s1", { activityAt: 1_000 }), session("quick", "s1", { activityAt: 999 }), session("elsewhere", "s2", { activityAt: 998 })],
    items: [...sessions.map((s) => item(s.id, "s1", s.id)), item("archived", "s1", "Archived", { archived: true }), item("elsewhere", "s2", "Elsewhere")],
  });
  const page = async (offset: number, limit: number) => {
    const got = await attempt(api(), rpc, "space.sessions", { id: "s1", offset, limit });
    if (!got.ok) throw new Error(got.message);
    return MobileCalls["space.sessions"].result.parse(got.result);
  };

  it("pages a space's listed sessions, newest first, by Home's rule, and says when there are more", async () => {
    const pages = [await page(0, 3), await page(3, 3), await page(6, 3)];
    // THE MUTANT: `more` read without the offset, and the last page says there is more after it.
    expect(pages.map((p) => [p.sessions.map((r) => r.id), p.more])).toEqual([
      [["s1-6", "s1-5", "s1-4"], true], [["s1-3", "s1-2", "s1-1"], true], [["s1-0"], false],
    ]);
    expect((await page(7, 3))).toEqual({ sessions: [], more: false });
  });

  it("refuses a space it does not have, and a page larger than a hundred", async () => {
    expect(await attempt(api(), rpc, "space.sessions", { id: "gone" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "space.sessions", { id: "s1", limit: 101 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

const probeRow = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, available: true, version: "1", loggedIn: true, reason: null, models: null, ...extra });

describe("session.options", () => {
  const options = async (s: Session, more: Partial<Record<MethodName, (p: never) => unknown>> = {}, settings: Record<string, unknown> = {}, log: StoredSessionEvent[] = []) => {
    const events = (p: { id: string; types?: string[] }) => log.filter((e) => e.sessionId === p.id && (!p.types || p.types.includes(e.event.type)));
    const got = await attempt(api(), fakeRpc({ sessions: [s], items: [], settings }, { "sessions.events": events as never, ...more }), "session.options", { id: s.id });
    if (!got.ok) throw new Error(got.message);
    return MobileCalls["session.options"].result.parse(got.result);
  };

  it("offers a Claude session the desktop picker's models, each with the levels Claude Code said it takes, and its modes and rungs", async () => {
    const o = await options(session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5", effort: "high", permissionMode: "acceptEdits" }), {},
      { "models.efforts": { "claude:claude-haiku-4-5": [] }, "sessions.midTurnMode": "steer" });
    expect(o).toMatchObject({ model: "claude-opus-5-5", modelLabel: "Opus 5.5", effort: "high", permissionMode: "acceptEdits", midTurn: "steer", attachments: SEND_LIMITS });
    // A session given a model cannot be put back on the default, so the default is not offered.
    expect(o.agent.models.map((m) => [m.id, m.label])).toEqual(AGENT_MODELS.claude.map((m) => [m.id, m.label.replace(/^Claude /, "")]));
    const opus = o.agent.models.find((m) => m.id === "claude-opus-5-5")!;
    expect(opus.efforts?.map((e) => e.label)).toEqual(["Low", "Medium", "High", "XHigh", "Max"]);
    expect(opus.defaultEffort).toBe("high");
    expect(o.agent.models.find((m) => m.id === "claude-haiku-4-5")).not.toHaveProperty("efforts");
    expect(o.agent).toMatchObject({ kind: "claude", name: "Claude", mark: "claude", available: true, note: null, efforts: [], steerNote: steerNote("claude") });
    expect(o.agent.defaultEffort).toBeUndefined();
    expect(o.agent.modes.map((m) => m.label)).toEqual(["Build", "Plan", "Ask"]);
    expect(o.agent.permissions).toEqual(PERMISSION_MODES.map(({ id, label }) => ({ id, label })));
  });

  it("leads with the agent's default, named, for a session that pinned no model; the Mac's mid-turn choice is Queue unless it says Steer", async () => {
    const o = await options(session("fresh", "s1", { agentKind: "claude", model: null }));
    expect(o.agent.models[0]).toMatchObject({ id: null, label: "Fable 5.1", defaultEffort: "high" });
    expect(o).toMatchObject({ modelLabel: "Fable 5.1", midTurn: "queue" });
  });

  it("reads Codex's models and each one's levels off the Mac's probe, the default's off the model its catalog marks", async () => {
    const models = [
      { id: "gpt-6-astra", label: "GPT-6 Astra", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low"], defaultEffort: "low" },
      { id: "gpt-6-plain", label: "GPT-6 Plain" },
    ];
    const o = await options(session("cx", "s1", { agentKind: "codex", model: null }), { "agents.probe": () => [probeRow("codex", { models })] });
    expect(o.agent.models.map((m) => [m.id, m.label, m.efforts?.map((e) => e.id) ?? null, m.defaultEffort ?? null])).toEqual([
      [null, "GPT-5.6", ["low", "medium", "high"], "medium"], ["gpt-6-astra", "GPT-6 Astra", ["low", "medium", "high"], "medium"],
      ["gpt-6-luna", "GPT-6 Luna", ["low"], "low"], ["gpt-6-plain", "GPT-6 Plain", null, null],
    ]);
    expect(o.agent.steerNote).toBe(steerNote("codex"));
  });

  it("offers an ACP agent the modes it named and its own reasoning levels, and no rungs, which Realm can't set on it", async () => {
    const init = sessionEvent("init", {
      providerSessionId: "c1", model: "composer-2", tools: [], cwd: "/tmp",
      availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }], efforts: [{ id: "fast", label: "Fast" }, { id: "deep", label: "deep" }], defaultEffort: "fast",
    });
    const o = await options(session("cur", "s1", { agentKind: "acp:cursor", model: null }), {}, {}, [{ seq: 1, sessionId: "cur", event: init }]);
    expect(o.agent.modes.map((m) => m.id)).toEqual(["build", "plan"]);
    expect(o.agent.permissions).toEqual([]);
    expect(o.agent.efforts).toEqual([{ id: "fast", label: "Fast" }, { id: "deep", label: "Deep" }]);
    // THE MUTANT: no default, and the phone cannot say which level runs while none is chosen.
    expect(o.agent.defaultEffort).toBe("fast");
    expect(o.agent.models).toEqual([{ id: null, label: "Composer" }]);
  });

  it("answers at once on the curated models while no probe has answered, and asks only the session's agent", async () => {
    const never = new Promise<never>(() => {});
    const asked: unknown[] = [];
    const started = Date.now();
    const o = await options(session("opus", "s1", { agentKind: "claude", model: "claude-opus-5-5" }), {
      "agents.probe": () => never, "agents.probeOne": (p: never) => { asked.push(p); return never; },
    });
    // THE MUTANT: wait on the agent's own probe without a limit, and the sheet never opens.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(asked).toEqual([{ kind: "claude" }]);
    expect(o.agent.models.map((m) => m.id)).toEqual(AGENT_MODELS.claude.map((m) => m.id));
  });

  it("takes the agent's own probe when the Mac has made none of every agent", async () => {
    const o = await options(session("cx", "s1", { agentKind: "codex", model: "gpt-6-luna" }), {
      "agents.probe": () => new Promise(() => {}), "agents.probeOne": () => probeRow("codex", { models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] }),
    });
    expect(o.modelLabel).toBe("GPT-6 Luna");
    expect(o.agent.models.map((m) => m.id)).toEqual(["gpt-6-luna"]);
  });
});

describe("session.configure", () => {
  /** A session the fake's `sessions.setOptions` changes in place, as the server's does, and what it was asked. */
  function rig(s: Session, settings: Record<string, unknown> = {}) {
    const sessions = [s];
    const set: unknown[] = [];
    const rpc = fakeRpc({ sessions, items: [], settings }, {
      "sessions.setOptions": ((p: { id: string } & Record<string, unknown>) => { const { id: _id, ...o } = p; set.push(o); return Object.assign(sessions[0]!, o); }) as never,
    });
    const configure = async (c: Record<string, unknown>) => attempt(api(), rpc, "session.configure", { id: s.id, ...c });
    return { set, configure };
  }

  it("puts Plan and Ask on the permission mode, and Build back on the Mac's default for new sessions", async () => {
    const { set, configure } = rig(session("c", "s1", { agentKind: "claude", permissionMode: "bypassPermissions" }), { "sessions.defaultPermissionMode": "acceptEdits" });
    const planned = await configure({ mode: "plan" });
    expect(planned).toMatchObject({ ok: true, result: { permissionMode: "plan" } });
    await configure({ mode: "ask" });
    await configure({ mode: "build" });
    expect(set).toEqual([{ permissionMode: "plan" }, { permissionMode: "ask" }, { permissionMode: "acceptEdits" }]);
  });

  it("keeps a session's own rung when it is in Build already, and takes a rung chosen without a mode as Build on it", async () => {
    const { set, configure } = rig(session("c", "s1", { agentKind: "claude", permissionMode: "bypassPermissions" }), { "sessions.defaultPermissionMode": "acceptEdits" });
    // THE MUTANT: Build always means the Mac's default, and a session on Full access is quietly lowered.
    await configure({ mode: "build" });
    expect(set).toEqual([]);
    await configure({ mode: "plan" });
    await configure({ permission: "default" });
    expect(set).toEqual([{ permissionMode: "plan" }, { permissionMode: "default" }]);
  });

  it("goes back to Ask each time from Plan when the Mac's default is not a rung", async () => {
    const { set, configure } = rig(session("c", "s1", { agentKind: "claude", permissionMode: "ask" }), { "sessions.defaultPermissionMode": "plan" });
    await configure({ mode: "build" });
    expect(set).toEqual([{ permissionMode: "default" }]);
  });

  it("sets a model and a level together, checking the level against the model chosen with it", async () => {
    const { set, configure } = rig(session("c", "s1", { agentKind: "claude", model: "claude-haiku-4-5" }), { "models.efforts": { "claude:claude-haiku-4-5": [] } });
    expect(await configure({ effort: "max" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    const both = await configure({ model: "claude-sonnet-5", effort: "max" });
    expect(both).toMatchObject({ ok: true, result: { model: "claude-sonnet-5", modelLabel: "Sonnet 5", effort: "max" } });
    await configure({ effort: null });
    expect(set).toEqual([{ model: "claude-sonnet-5", effort: "max" }, { effort: null }]);
  });

  it("refuses what the agent does not offer, and changes nothing for it", async () => {
    const claude = rig(session("c", "s1", { agentKind: "claude", model: "claude-opus-5-5" }));
    for (const c of [{ model: "gpt-6-astra" }, { model: null }, { effort: "turbo" }, { permission: "sudo" }, { mode: "plan", permission: "default" }]) {
      expect(await claude.configure(c), JSON.stringify(c)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    const cursor = rig(session("a", "s1", { agentKind: "acp:cursor" }));
    for (const c of [{ permission: "bypassPermissions" }, { mode: "plan" }, { effort: "high" }]) {
      expect(await cursor.configure(c), JSON.stringify(c)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect([...claude.set, ...cursor.set]).toEqual([]);
  });
});

describe("agents.list", () => {
  const list = async (settings: Record<string, unknown>) => {
    const rpc = fakeRpc({ sessions: [], items: [], settings }, { "agents.probe": () => [
      probeRow("claude", { loggedIn: null }), probeRow("codex", { available: false, reason: "not on PATH" }), probeRow("acp:copilot", { loggedIn: false }),
      probeRow("acp:opencode", { efforts: [{ id: "low", label: "low" }, { id: "high", label: "Think hard" }], defaultEffort: "low" }),
      probeRow("acp:goose", { efforts: [{ id: "auto", label: "Auto" }] }),
    ] });
    const got = await attempt(api(), rpc, "agents.list", {});
    if (!got.ok) throw new Error(got.message);
    return MobileCalls["agents.list"].result.parse(got.result);
  };

  it("offers every agent the desktop's new session does, saying which cannot run and why", async () => {
    const l = await list({});
    expect(l.agents.map((a) => a.kind)).toEqual([...SELECTABLE_AGENT_KINDS]);
    expect(l.agents.filter((a) => !a.available).map((a) => [a.kind, a.note])).toEqual([["codex", "not installed"], ["acp:copilot", "signed out"]]);
    // A new session may start on an agent's own default.
    for (const a of l.agents) expect(a.models[0]?.id, a.kind).toBeNull();
    // An agent's own levels come with the one it starts on, where its probe named one.
    const own = (kind: string) => l.agents.find((a) => a.kind === kind)!;
    expect([own("acp:opencode").efforts.map((e) => e.label), own("acp:opencode").defaultEffort]).toEqual([["Low", "Think hard"], "low"]);
    expect([own("acp:goose").efforts.map((e) => e.id), own("acp:goose").defaultEffort]).toEqual([["auto"], null]);
    expect(own("acp:grok")).not.toHaveProperty("defaultEffort");
    expect(l).toMatchObject({ midTurn: "queue", attachments: SEND_LIMITS });
  });

  it("names the agent the desktop's \"+\" would reach for, and Claude when that is none it offers", async () => {
    expect((await list({ "ui.lastAgentKind": "codex" })).defaultAgent).toBe("codex");
    expect((await list({ "ui.lastAgentKind": "fake" })).defaultAgent).toBe("claude");
    expect((await list({})).defaultAgent).toBe("claude");
  });
});

/** The bytes of a picture of each kind every agent takes, as far as their first bytes go. */
const PICTURE = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  gif: Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
  webp: Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"),
};
const upload = (name: string, mime: string, bytes: Buffer | string) => ({ name, mime, data: Buffer.from(bytes).toString("base64") });

describe("session.send with files", () => {
  function rig() {
    const home = tempDir("realm-phone-home-");
    const sent: { id: string; text: string; attachments: { path: string; mime: string }[]; delivery: string }[] = [];
    const rpc = fakeRpc({ sessions: [session("s1", "s1")], items: [] }, { "sessions.send": ((p: (typeof sent)[number]) => { sent.push(p); return { ok: true }; }) as never });
    const dir = join(home, "tmp", "attachments");
    const files = () => (existsSync(dir) ? readdirSync(dir) : []);
    return { home, dir, sent, files, send: (params: Record<string, unknown>) => attempt(api(undefined, home), rpc, "session.send", { id: "s1", text: "look", ...params }) };
  }

  it("writes each file where a desktop paste goes, under a name of its own, and sends the session their paths", async () => {
    const r = rig();
    const got = await r.send({ delivery: "steer", attachments: [
      upload("../../Library/LaunchAgents/evil.plist", "application/xml", "<plist/>"), upload("IMG_0042.jpg", "image/jpeg", PICTURE.jpeg),
      upload("Camera", "image/png", PICTURE.png), upload("notes.txt", "text/plain; charset=utf-8", "hello"),
    ] });
    expect(got).toEqual({ ok: true, result: { ok: true } });
    expect(r.sent).toHaveLength(1);
    const { attachments, ...rest } = r.sent[0]!;
    expect(rest).toEqual({ id: "s1", text: "look", delivery: "steer" });
    // THE MUTANT: write the name the phone gave, and `../..` puts a file in LaunchAgents.
    expect(attachments.map((a) => [dirname(a.path), basename(a.path).replace(/^[0-9a-f]{12}-/, ""), a.mime])).toEqual([
      [r.dir, "evil.plist", "application/xml"], [r.dir, "IMG_0042.jpg", "image/jpeg"], [r.dir, "Camera.png", "image/png"], [r.dir, "notes.txt", "text/plain"],
    ]);
    for (const a of attachments) expect(basename(a.path)).toMatch(/^[0-9a-f]{12}-/);
    expect(readFileSync(attachments[1]!.path)).toEqual(PICTURE.jpeg);
    expect(readFileSync(attachments[3]!.path, "utf8")).toBe("hello");
    expect(r.files()).toHaveLength(4);
    expect(existsSync(join(r.home, "Library"))).toBe(false);
  });

  it("sends files with no words, and refuses a message with neither", async () => {
    const r = rig();
    expect(await r.send({ text: "", attachments: [] })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(r.sent).toEqual([]);
    expect(await r.send({ text: "", attachments: [upload("shot.gif", "image/gif", PICTURE.gif)] })).toMatchObject({ ok: true });
    expect(r.sent[0]).toMatchObject({ text: "", attachments: [{ mime: "image/gif" }] });
  });

  it("takes a file of the most the Mac takes, and refuses more — one file, or all of them together — before writing any", async () => {
    const r = rig();
    const big = (n: number) => Buffer.alloc(n, 7);
    const rest = SEND_LIMITS.maxTotalBytes - SEND_LIMITS.maxBytes;
    expect(await r.send({ attachments: [upload("exactly.bin", "application/octet-stream", big(SEND_LIMITS.maxBytes))] })).toMatchObject({ ok: true });
    expect(await r.send({ attachments: [upload("most.bin", "application/octet-stream", big(SEND_LIMITS.maxBytes)), upload("rest.bin", "application/octet-stream", big(rest))] }))
      .toMatchObject({ ok: true });
    const before = r.files().length;
    for (const attachments of [
      [upload("over.bin", "application/octet-stream", big(SEND_LIMITS.maxBytes + 1))],
      [upload("half.bin", "application/octet-stream", big(6 * 1024 * 1024)), upload("other-half.bin", "application/octet-stream", big(6 * 1024 * 1024))],
      // One byte over in all, which only the files' real sizes show: their base64 alone reads a byte or two under.
      [upload("most.bin", "application/octet-stream", big(SEND_LIMITS.maxBytes)), upload("rest.bin", "application/octet-stream", big(rest + 1))],
      Array.from({ length: SEND_LIMITS.maxCount + 1 }, (_, i) => upload(`${i}.txt`, "text/plain", "x")),
    ]) {
      expect(await r.send({ attachments }), `${attachments.length} files`).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect(r.files().length).toBe(before);
    expect(r.sent).toHaveLength(2);
  });

  it("takes only base64 exactly as it encodes", async () => {
    const r = rig();
    // Short of its padding, spaced, wrapped, the URL-safe alphabet, and loose bits a decoder would drop.
    for (const data of ["aGVsbG8", "aGVs bG8=", "aGVsbG8=\n", "-_8=", "QR=="]) {
      expect(await r.send({ attachments: [{ name: "a.txt", mime: "text/plain", data }] }), JSON.stringify(data)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect(r.files()).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("takes a picture only as one of the four kinds every agent takes inline, and only when it is one", async () => {
    const r = rig();
    for (const u of [upload("IMG.heic", "image/heic", "heic"), upload("shot.png", "image/png", PICTURE.jpeg), upload("vector.svg", "image/svg+xml", "<svg/>"),
      upload("x", "not a type", "x")]) {
      expect(await r.send({ attachments: [u] }), u.name).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect(r.files()).toEqual([]);
    expect(await r.send({ attachments: [upload("a.gif", "image/gif", PICTURE.gif), upload("b.webp", "image/webp", PICTURE.webp)] })).toMatchObject({ ok: true });
  });

  it("writes nothing through an attachments folder that is a link to somewhere else", async () => {
    const r = rig();
    const elsewhere = tempDir("realm-elsewhere-");
    mkdirSync(join(r.home, "tmp"));
    symlinkSync(elsewhere, r.dir);
    expect(await r.send({ attachments: [upload("notes.txt", "text/plain", "hello")] })).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("sweeps what a day has left in the folder, as a paste does", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true });
    const old = join(r.dir, "aaaaaaaaaaaa-yesterday.png");
    writeFileSync(old, "old");
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    await r.send({ attachments: [upload("today.txt", "text/plain", "new")] });
    await vi.waitFor(() => expect(existsSync(old)).toBe(false));
    expect(r.files()).toHaveLength(1);
  });
});

describe("session.create, on what the phone chose", () => {
  function rig(settings: Record<string, unknown> = {}) {
    const home = tempDir("realm-phone-home-");
    const created: unknown[] = [];
    const sent: unknown[] = [];
    const rpc = fakeRpc({ sessions: [], items: [], settings }, {
      "sessions.create": ((p: { spaceId: string; agentKind: Session["agentKind"] }) => { created.push(p); return { session: session("new", p.spaceId, { agentKind: p.agentKind }), itemId: "i-new" }; }) as never,
      "sessions.send": ((p: unknown) => { sent.push(p); return { ok: true }; }) as never,
    });
    return { created, sent, create: (params: Record<string, unknown>) => attempt(api(undefined, home), rpc, "session.create", { spaceId: "s1", ...params }) };
  }
  const made = (o: Record<string, unknown>) => ({ spaceId: "s1", model: null, effort: null, permissionMode: null, ...o });

  it("makes the session on the model, level, mode and rung chosen, then sends its first message with its files", async () => {
    const r = rig();
    const got = await r.create({ agent: "claude", text: "", model: "claude-sonnet-5", effort: "max", permission: "bypassPermissions", attachments: [upload("shot.png", "image/png", PICTURE.png)] });
    expect(got).toEqual({ ok: true, result: { id: "new" } });
    expect(r.created).toEqual([made({ agentKind: "claude", model: "claude-sonnet-5", effort: "max", permissionMode: "bypassPermissions" })]);
    expect(r.sent).toEqual([{ id: "new", text: "", attachments: [{ path: expect.stringMatching(/\/tmp\/attachments\/[0-9a-f]{12}-shot\.png$/), mime: "image/png" }] }]);
  });

  it("starts Plan and Ask as their modes, and leaves the rest to the Mac's own defaults", async () => {
    const r = rig({ "sessions.defaultPermissionMode": "acceptEdits" });
    await r.create({ agent: "codex", text: "plan it", mode: "plan" });
    await r.create({ agent: "claude", text: "hello" });
    await r.create({ agent: "claude", text: "hello", mode: "build" });
    expect(r.created).toEqual([made({ agentKind: "codex", permissionMode: "plan" }), made({ agentKind: "claude" }), made({ agentKind: "claude" })]);
  });

  it("makes nothing when a choice, a file or the message is refused", async () => {
    const r = rig();
    for (const params of [
      { agent: "claude", text: "hi", model: "gpt-6-astra" }, { agent: "acp:cursor", text: "hi", permission: "bypassPermissions" },
      { agent: "claude", text: "hi", attachments: [upload("IMG.heic", "image/heic", "heic")] }, { agent: "claude", text: "" }, { agent: "nobody", text: "hi" },
    ]) {
      expect(await r.create(params), JSON.stringify(params)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect(r.created).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});

describe("session.file, for a file sent with a message", () => {
  it("names a file sent from a phone or pasted as it was given, without the prefix it was written under", async () => {
    const home = tempDir("realm-sent-home-");
    const dir = join(home, "tmp", "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "3f9a1c2b4d5e-brief.md"), "# Brief\n");
    const elsewhere = tempDir("realm-sent-");
    writeFileSync(join(elsewhere, "0123456789ab-notes.md"), "# Notes\n");
    const sent = [join(dir, "3f9a1c2b4d5e-brief.md"), join(elsewhere, "0123456789ab-notes.md")];
    const log = [stored("s1", sessionEvent("user_message", { text: "read these", attachments: sent.map((path) => ({ path, mime: "text/markdown" })) }))];
    const rpc = fakeRpc({ sessions: [], items: [] }, { "sessions.events": eventsOf(log) as never });
    expect(await attempt(api(undefined, home), rpc, "session.file", { id: "s1", path: sent[0]! })).toMatchObject({ ok: true, result: { path: sent[0], name: "brief.md" } });
    // A file the person picked keeps its own name, whatever it looks like.
    expect(await attempt(api(undefined, home), rpc, "session.file", { id: "s1", path: sent[1]! })).toMatchObject({ ok: true, result: { name: "0123456789ab-notes.md" } });
  });

  it("previews a file a message to this session carried, and still nothing beside it", async () => {
    const dir = tempDir("realm-sent-");
    writeFileSync(join(dir, "brief.md"), "# Brief\n");
    writeFileSync(join(dir, "beside.md"), "not sent\n");
    const log = [stored("s1", sessionEvent("user_message", { text: "read this", attachments: [{ path: join(dir, "brief.md"), mime: "text/markdown" }] }))];
    const rpc = fakeRpc({ sessions: [], items: [] }, { "sessions.events": eventsOf(log) as never });
    // THE MUTANT: read only `files_made`, and a photo the phone sent cannot be shown in its own bubble.
    expect(await attempt(api(), rpc, "session.file", { id: "s1", path: join(dir, "brief.md") })).toMatchObject({ ok: true, result: { name: "brief.md", preview: { kind: "text", text: "# Brief\n" } } });
    expect(await attempt(api(), rpc, "session.file", { id: "s1", path: join(dir, "beside.md") })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("sends no file that holds a secret, though a message on the Mac carried it", async () => {
    const dir = tempDir("realm-sent-");
    mkdirSync(join(dir, ".ssh"));
    writeFileSync(join(dir, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(dir, ".env"), "API_KEY=1\n");
    const keys = [join(dir, ".ssh", "id_ed25519"), join(dir, ".env")];
    const log = [stored("s1", sessionEvent("user_message", { text: "why does this fail?", attachments: keys.map((path) => ({ path, mime: "text/plain" })) }))];
    const rpc = fakeRpc({ sessions: [], items: [] }, { "sessions.events": eventsOf(log) as never });
    for (const path of keys) expect(await attempt(api(), rpc, "session.file", { id: "s1", path }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

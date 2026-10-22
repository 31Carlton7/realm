import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import {
  AGENT_MODELS, PERMISSION_MODES, SELECTABLE_AGENT_KINDS, sessionEvent, steerNote, type DelegatedChild, type FileDiff, type Item, type MethodName, type PlanLimits,
  type QueuedPrompt, type Run, type Schedule, type Session, type StoredSessionEvent, type TeamReviewDetail, type TeamReviewItem, type TeamReviewSummary,
  type TurnChanges, type UsageSessionRow,
} from "@realm/contracts";
import { HomeSchema, MobileCalls, RECENT_LIMIT, SEND_LIMITS } from "@realm/remote";
import { needsYou } from "@realm/view";
import { ICON_MAX_BYTES, MobileApi, MobileError, needsYouInput } from "./api";
import { channel, fakeRpc, item, profile, session, space, type Lists } from "./api.test-fakes";
import { DIFF_PAGE_BYTES } from "./changes";
import { PREVIEW_MAX_BYTES, TEXT_HEAD_BYTES, type Downscale } from "./preview";
import { RpcCallError, type RpcPort } from "./rpc-port";

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
    expect(await page(7, 3)).toEqual({ sessions: [], more: false });
  });

  it("refuses a space it does not have, and a page larger than a hundred", async () => {
    expect(await attempt(api(), rpc, "space.sessions", { id: "gone" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "space.sessions", { id: "s1", limit: 101 })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });
});

const probeRow = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, available: true, version: "1", loggedIn: true, reason: null, models: null, ...extra });

describe("session.options", () => {
  const options = async (s: Session, more: Partial<Record<MethodName, (p: never) => unknown>> = {}, settings: Record<string, unknown> = {}) => {
    const got = await attempt(api(), fakeRpc({ sessions: [s], items: [], settings }, more), "session.options", { id: s.id });
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
    const o = await options(session("cur", "s1", { agentKind: "acp:cursor", model: null }), { "sessions.events": eventsOf([stored("cur", init)]) as never });
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
    return { home, created, sent, create: (params: Record<string, unknown>) => attempt(api(undefined, home), rpc, "session.create", { spaceId: "s1", ...params }) };
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

  it("makes nothing when its files cannot be written", async () => {
    const r = rig();
    mkdirSync(join(r.home, "tmp"));
    symlinkSync(tempDir("realm-elsewhere-"), join(r.home, "tmp", "attachments"));
    // THE MUTANT: make the session first, and a phone that tries again leaves an empty one each time.
    expect(await r.create({ agent: "claude", text: "look", attachments: [upload("shot.png", "image/png", PICTURE.png)] })).toMatchObject({ ok: false, code: "INTERNAL" });
    expect(r.created).toEqual([]);
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

/** Every call the fake answered, with what it was asked, for the calls a phone's action becomes. */
function recorded(h: Lists, more: Partial<Record<MethodName, (p: never) => unknown>> = {}) {
  const asked: [string, unknown][] = [];
  const wrapped = Object.fromEntries(Object.entries(more).map(([m, fn]) => [m, (p: never) => { asked.push([m, p]); return fn(p); }]));
  return { rpc: fakeRpc(h, wrapped), asked };
}

describe("session.update", () => {
  /** A space's own list, archived rows and all, and a change to one that every list then carries. */
  function rig(items: Item[]) {
    return recorded({ sessions: [session("s1", "s1", { title: "Its own title" }), session("bare", "s1")], items }, {
      "items.list": ((p: { spaceId: string }) => items.filter((it) => it.spaceId === p.spaceId)) as never,
      "items.update": ((p: { id: string } & Partial<Item>) => {
        const at = items.findIndex((it) => it.id === p.id);
        items[at] = { ...items[at]!, ...p };
        return items[at];
      }) as never,
    });
  }

  it("renames and pins the session's own row, as the sidebar does, and answers the row as it now is", async () => {
    const { rpc, asked } = rig([item("s1", "s1", "Theme column")]);
    const got = await attempt(api(), rpc, "session.update", { id: "s1", title: "  Theme column, v2 ", pinned: true });
    expect(got).toMatchObject({ ok: true, result: { session: { id: "s1", title: "Theme column, v2", pinned: true } } });
    // Only what was asked changes: a pin alone leaves the name, and nothing is archived.
    expect(asked).toEqual([["items.list", { spaceId: "s1" }], ["items.update", { id: "i-s1", title: "Theme column, v2", pinned: true }]]);
    await attempt(api(), rpc, "session.update", { id: "s1", pinned: false });
    expect(asked.at(-1)).toEqual(["items.update", { id: "i-s1", pinned: false }]);
  });

  it("answers no row once it is archived, and finds an archived row to take it back", async () => {
    const { rpc, asked } = rig([item("s1", "s1", "Theme column")]);
    expect(await attempt(api(), rpc, "session.update", { id: "s1", archived: true })).toEqual({ ok: true, result: { session: null } });
    expect(asked.at(-1)).toEqual(["items.update", { id: "i-s1", archived: true }]);
    // THE MUTANT: look the row up in `items.listAll`, which leaves archived rows out — then a row put
    // away from the phone can never be taken back from it.
    expect(await attempt(api(), rpc, "session.update", { id: "s1", archived: false })).toMatchObject({ ok: true, result: { session: { id: "s1", title: "Theme column" } } });
  });

  it("refuses a session it does not have, one with no row, and a name of nothing, changing nothing", async () => {
    const { rpc, asked } = rig([item("s1", "s1", "Theme column")]);
    expect(await attempt(api(), rpc, "session.update", { id: "gone", pinned: true })).toMatchObject({ ok: false });
    expect(await attempt(api(), rpc, "session.update", { id: "bare", pinned: true })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "session.update", { id: "s1", title: "   " })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(asked.filter(([m]) => m === "items.update")).toEqual([]);
  });

  it("says on every row whether it is pinned", async () => {
    const h = await home({
      sessions: [session("pinned", "s1", { activityAt: 2 }), session("loose", "s1", { activityAt: 1 })],
      items: [item("pinned", "s1", "Pinned", { pinned: true }), item("loose", "s1", "Loose")],
    });
    // THE MUTANT: `pinned: false` on every row, and Home's Pinned is always empty.
    expect(h.spaces[0]!.sessions.map((r) => [r.id, r.pinned])).toEqual([["pinned", true], ["loose", false]]);
    expect(h.recent?.map((r) => r.pinned)).toEqual([true, false]);
  });
});

describe("the queue", () => {
  const home = tempDir("realm-queue-home-");
  const sent = join(home, "tmp", "attachments", "5e6f7a8b9c0d-sketch.png");
  mkdirSync(dirname(sent), { recursive: true });
  writeFileSync(sent, "png");
  const waiting: QueuedPrompt[] = [
    { id: "q1", text: "Then rename the column", attachments: [], ts: 10, held: true },
    { id: "q2", text: "", attachments: [{ path: sent, mime: "image/png" }], ts: 20, held: false },
  ];
  const lists = (queued: QueuedPrompt[] = waiting): Lists => ({ sessions: [session("s1", "s1")], items: [item("s1", "s1", "Theme column")], queued: { s1: queued } });

  it("is read with the session and on its own, each file named as its row will name it, as of when it was queued", async () => {
    const rpc = fakeRpc(lists());
    const expected = [
      { id: "q1", text: "Then rename the column", attachments: [], at: 10, held: true },
      { id: "q2", text: "", attachments: [{ path: sent, name: "sketch.png", mime: "image/png" }], at: 20, held: false },
    ];
    expect(await attempt(api(undefined, home), rpc, "session.queue", { id: "s1" })).toEqual({ ok: true, result: { queued: expected } });
    expect(await attempt(api(undefined, home), rpc, "session.open", { id: "s1" })).toMatchObject({ ok: true, result: { queued: expected } });
  });

  it("sends now, removes, holds and edits a message by the desktop's own calls, keeping an edited message's files", async () => {
    const { rpc, asked } = recorded(lists(), {
      "sessions.releaseQueued": (() => ({ ok: true })) as never, "sessions.dequeue": (() => ({ ok: true })) as never,
      "sessions.holdQueued": ((p: { held: boolean }) => ({ ok: true, held: p.held })) as never, "sessions.editQueued": (() => ({ edited: true })) as never,
    });
    for (const [method, params] of [
      ["session.sendQueuedNow", { id: "s1", queuedId: "q1" }], ["session.removeQueued", { id: "s1", queuedId: "q2" }],
      ["session.holdQueued", { id: "s1", queuedId: "q1", held: true }], ["session.editQueued", { id: "s1", queuedId: "q2", text: "Use this sketch" }],
    ] as const) expect(await attempt(api(), rpc, method, params), method).toEqual({ ok: true, result: { ok: true } });
    // THE MUTANT: hand the edit `attachments: []`, and a message queued with a photo loses it.
    expect(asked).toEqual([
      ["sessions.releaseQueued", { id: "s1", queuedId: "q1" }], ["sessions.dequeue", { id: "s1", queuedId: "q2" }],
      ["sessions.holdQueued", { id: "s1", queuedId: "q1", held: true }], ["sessions.editQueued", { id: "s1", queuedId: "q2", text: "Use this sketch" }],
    ]);
  });

  it("says a message is gone when a hold or an edit comes after it went out, and lets go of a hold quietly", async () => {
    const rpc = fakeRpc(lists(), {
      "sessions.holdQueued": (() => ({ ok: true, held: false })) as never, "sessions.editQueued": (() => ({ edited: false })) as never,
    });
    // THE MUTANT: answer `{ok: true}` to a hold the Mac could not take, and the phone opens an editor on
    // a message that has already been sent.
    expect(await attempt(api(), rpc, "session.holdQueued", { id: "s1", queuedId: "q1", held: true })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await attempt(api(), rpc, "session.holdQueued", { id: "s1", queuedId: "q1", held: false })).toEqual({ ok: true, result: { ok: true } });
    expect(await attempt(api(), rpc, "session.editQueued", { id: "s1", queuedId: "q1", text: "too late" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("takes an edit down to no words only for a message that still carries a file", async () => {
    const { rpc, asked } = recorded(lists(), { "sessions.editQueued": (() => ({ edited: true })) as never });
    expect(await attempt(api(), rpc, "session.editQueued", { id: "s1", queuedId: "q1", text: "" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(await attempt(api(), rpc, "session.editQueued", { id: "s1", queuedId: "q2", text: "" })).toEqual({ ok: true, result: { ok: true } });
    expect(asked).toEqual([["sessions.editQueued", { id: "s1", queuedId: "q2", text: "" }]]);
  });

  it("lets session.file preview a file a waiting message carries, and not once it has gone", async () => {
    // THE MUTANT: leave the queue out of what `session.file` may read, and a queued photo has no picture.
    expect(await attempt(api(undefined, home), fakeRpc(lists()), "session.file", { id: "s1", path: sent })).toMatchObject({ ok: true, result: { name: "sketch.png" } });
    expect(await attempt(api(undefined, home), fakeRpc(lists([])), "session.file", { id: "s1", path: sent })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("session.subagents", () => {
  const lead = { sessionId: "lead", kind: "agent_run" } as const;
  const child = (id: string, extra: Partial<DelegatedChild>, s: Partial<Session> = {}): DelegatedChild => ({
    session: session(id, "s1", { dispatchedBy: lead, title: `${id} (task)`, updatedAt: 900, ...s }),
    goal: `Do ${id}`, startedAt: 100, settledAt: null, outcome: null, report: null, activity: null, ...extra,
  });
  const children = [
    child("working", { startedAt: 500 }, { status: "running" }),
    child("asking", { startedAt: 400 }, { status: "waiting_permission" }),
    child("finished", { startedAt: 300, settledAt: 350, outcome: "done", report: "Done it." }),
    child("cut-short", { startedAt: 200, settledAt: 250, outcome: "interrupted", note: "Stopped when the session that started it was stopped." }),
    // A reviewer keeps no record: it finished when it last spoke, and its report says it did.
    child("reviewer", { startedAt: 150, report: "Looks right.", activity: sessionEvent("assistant_text", { messageId: "m", text: "Looks right." }, 180) }),
    // Started and not yet on its first turn: its run is in flight.
    child("starting", { startedAt: 600 }),
  ];
  const rpc = fakeRpc({ sessions: [session("lead", "s1")], items: [item("lead", "s1", "Lead"), item("finished", "s1", "Write the migration")] }, {
    "delegation.children": ((p: { sessionId: string }) => ({ children: p.sessionId === "lead" ? children : [], dismissed: [] })) as never,
    "delegation.running": (() => ({ running: [{ sessionId: "starting", startedAt: 600, detached: true, owned: true }, { sessionId: "working", startedAt: 500, detached: true, owned: true }] })) as never,
  });

  it("lists a lead's sub-agents newest first, each ended one with how it ended in the Agents tab's word", async () => {
    const got = await attempt(api(), rpc, "session.subagents", { id: "lead" });
    if (!got.ok) throw new Error(got.message);
    const { subagents } = MobileCalls["session.subagents"].result.parse(got.result);
    // THE MUTANTS: the outcome as `agent_run` recorded it ("interrupted"), and the reviewer, which kept
    // none, would have no word at all; read without the runs in flight, the one starting is "stopped".
    expect(subagents.map((s) => [s.session.id, s.outcome, s.settledAt])).toEqual([
      ["starting", null, null], ["working", null, null], ["asking", null, null], ["finished", "done", 350],
      ["cut-short", "cancelled", 250], ["reviewer", "done", 180],
    ]);
    expect(subagents.find((s) => s.session.id === "cut-short")).toMatchObject({ note: "Stopped when the session that started it was stopped.", report: null });
    // Each is its own session's row, by the name its sidebar row has.
    expect(subagents.find((s) => s.session.id === "finished")).toMatchObject({ goal: "Do finished", report: "Done it.", session: { title: "Write the migration", status: "idle" } });
    expect(subagents.find((s) => s.session.id === "asking")?.session.status).toBe("waiting");
  });

  it("refuses a session the Mac does not have", async () => {
    expect(await attempt(api(), rpc, "session.subagents", { id: "nobody" })).toMatchObject({ ok: false });
  });
});

describe("usage.get", () => {
  const plan = (agentKind: string, extra: Partial<PlanLimits> = {}): PlanLimits =>
    ({ agentKind, subscriptionType: null, organization: null, windows: [], alert: "none", alertWindow: null, unavailable: null, detail: null, ts: 0, ...extra });
  const later = Date.now() + 86_400_000;
  const limits = [
    plan("acp:cursor", { unavailable: "unsupported" }),
    plan("codex", { unavailable: "unreadable", detail: "the app-server closed" }),
    plan("claude", { subscriptionType: "max", alert: "exceeded", alertWindow: "five_hour", ts: 123, windows: [
      { id: "seven_day", label: "Weekly", utilization: 40, resetsAt: later },
      { id: "five_hour", label: "5-hour", utilization: 104, resetsAt: later },
      { id: "seven_day_opus", label: "Opus weekly", utilization: 90, resetsAt: Date.now() - 1_000 },
      { id: "model:Fable", label: "Fable weekly", utilization: null, resetsAt: null },
    ] }),
    plan("acp:gemini"),
    plan("fake", { windows: [{ id: "five_hour", label: "5-hour", utilization: 5, resetsAt: later }] }),
  ];
  const row = (id: string, costUsd: number, title = "Session"): UsageSessionRow => ({
    id, title, spaceId: "s1", spaceName: "Space s1", agentKind: "claude", model: null, createdAt: 0, updatedAt: 0,
    totals: { costUsd, reportedUsd: costUsd, estimatedUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, sessions: 1, unmeasuredSessions: 0 },
  });
  const month = {
    sessions: [row("a", 1), row("b", 7), row("c", 0), row("d", 3, "Its own title"), row("e", 5), row("f", 2), row("g", 4)],
    budget: { budget: { monthlyUsd: 50, thresholds: [0.5, 0.8, 1], includeEstimated: true }, monthSpendUsd: 22, monthStart: 0, projectedUsd: null },
  };
  const rig = () => recorded({ sessions: [], items: [item("b", "s1", "The heavy one"), item("d", "s1", "Renamed")] }, {
    "limits.get": (() => ({ limits })) as never, "usage.summary": (() => month) as never,
  });

  it("draws each agent a person can run as the Usage page does: fullest window first, no figure it cannot stand behind", async () => {
    const got = await attempt(api(), rig().rpc, "usage.get", {});
    if (!got.ok) throw new Error(got.message);
    const usage = MobileCalls["usage.get"].result.parse(got.result);
    // Those that report first, then those that cannot; the scripted agent no person runs is left out.
    expect(usage.limits.map((l) => l.agent)).toEqual(["claude", "codex", "acp:cursor", "acp:gemini"]);
    const claude = usage.limits[0]!;
    expect(claude).toMatchObject({ agentName: "Claude", agentMark: "claude", plan: "max", at: 123, alert: "5-hour limit reached", unavailable: null });
    // THE MUTANT: drop the reset check, and a window that has started again shows the 90% it no longer has.
    expect(claude.windows.map((w) => [w.id, w.usedPercent])).toEqual([["five_hour", 100], ["seven_day_opus", null], ["seven_day", 40], ["model:Fable", null]]);
    // An agent with nothing to draw says why, in the page's sentence — one that reports and has not
    // been heard from yet included.
    expect(usage.limits.slice(1).map((l) => [l.alert, l.unavailable])).toEqual([
      [null, "Codex could not be asked for its plan limits. (the app-server closed)"],
      [null, "Cursor does not report plan limits."],
      [null, "Run a Gemini session and its plan limits will appear here."],
    ]);
  });

  it("says a warning the provider gave without naming a window, and drops one whose window has reset", async () => {
    const at = (alertWindow: string | null, resetsAt: number) => recorded({ sessions: [], items: [] }, {
      "limits.get": (() => ({ limits: [plan("claude", { alert: "approaching", alertWindow, windows: [{ id: "seven_day", label: "Weekly", utilization: 81, resetsAt }] })] })) as never,
      "usage.summary": (() => month) as never,
    });
    const alertOf = async (alertWindow: string | null, resetsAt: number) =>
      MobileCalls["usage.get"].result.parse(((await attempt(api(), at(alertWindow, resetsAt).rpc, "usage.get", {})) as { result: unknown }).result).limits[0]!.alert;
    expect(await alertOf(null, later)).toBe("Limit nearly reached");
    expect(await alertOf("seven_day", later)).toBe("Weekly limit nearly reached");
    expect(await alertOf("seven_day", Date.now() - 1_000)).toBeNull();
  });

  it("counts this calendar month on the Mac's clock, against its budget, with its five heaviest sessions by their rows' names", async () => {
    const { rpc, asked } = rig();
    const before = Date.now();
    const got = await attempt(api(), rpc, "usage.get", {});
    if (!got.ok) throw new Error(got.message);
    const { spend } = MobileCalls["usage.get"].result.parse(got.result);
    const first = new Date(before);
    // THE MUTANT: the last thirty days for "this month", and the meter reads a different sum from the Mac's.
    const [, range] = asked.find(([m]) => m === "usage.summary") as [string, { from: number; to: number }];
    expect(range.from).toBe(new Date(first.getFullYear(), first.getMonth(), 1).getTime());
    expect(range.to).toBeGreaterThanOrEqual(before);
    expect(spend.monthToDate).toBe(22);
    expect(spend.budget).toBe(50);
    expect(spend.topSessions.map((s) => [s.id, s.title, s.cost])).toEqual([
      ["b", "The heavy one", 7], ["e", "Session", 5], ["g", "Session", 4], ["d", "Renamed", 3], ["f", "Session", 2],
    ]);
  });

  it("says there is no budget when the Mac has none set", async () => {
    const rpc = fakeRpc({ sessions: [], items: [] }, {
      "limits.get": (() => ({ limits: [] })) as never,
      "usage.summary": (() => ({ ...month, sessions: [], budget: { ...month.budget, budget: { ...month.budget.budget, monthlyUsd: null } } })) as never,
    });
    expect(await attempt(api(), rpc, "usage.get", {})).toMatchObject({ ok: true, result: { limits: [], spend: { budget: null, topSessions: [] } } });
  });
});

describe("Review", () => {
  const review = (id: string, spaceId: string, state: TeamReviewSummary["state"], updatedAt: number, extra: Partial<TeamReviewSummary> = {}): TeamReviewSummary => ({
    id, spaceId, roleId: "role", roleName: "Content Producer", runId: null, sessionId: "role-session", recordPath: null, kind: "slideshows", title: id,
    state, note: null, version: 1, itemCount: 1, thumb: null, channels: [], account: null, to: null, changedSinceApproval: false, actsTotal: 0, actsDone: 0,
    createdAt: 0, decidedAt: null, updatedAt, ...extra,
  });
  const teams = [
    { spaceId: "s1", reviews: [review("waiting", "s1", "waiting", 300), review("done", "s1", "done", 900), review("approved", "s1", "approved", 100)] },
    { spaceId: "s2", reviews: [review("sent-back", "s2", "changes", 200, { note: "Shorter" }), review("rejected", "s2", "rejected", 800),
      review("closed", "s2", "closed", 700), review("put-away", "s2", "dismissed", 600)] },
  ];

  it("lists what every team has handed back and is still open, newest first, and nothing that has come to rest", async () => {
    const rpc = fakeRpc({ sessions: [], items: [] }, { "team.overview": (() => teams) as never });
    const got = await attempt(api(), rpc, "reviews.list", {});
    if (!got.ok) throw new Error(got.message);
    const { reviews } = MobileCalls["reviews.list"].result.parse(got.result);
    // THE MUTANT: only what waits for a yes, and a batch sent back or approved and not yet posted
    // vanishes from the phone while the desktop's Review still shows it.
    expect(reviews.map((r) => [r.id, r.state, r.spaceName])).toEqual([
      ["waiting", "waiting", "Space s1"], ["sent-back", "changes", "Space s2"], ["approved", "approved", "Space s1"],
    ]);
    expect(reviews[1]).toMatchObject({ note: "Shorter", roleName: "Content Producer", sessionId: "role-session" });
  });

  /** A review in a space folder with a picture, an email and a document, and the calls its decisions make. */
  function rig() {
    const root = tempDir("realm-review-");
    mkdirSync(join(root, "renders"));
    writeFileSync(join(root, "renders", "toggle.png"), "png");
    writeFileSync(join(root, "brief.pdf"), "%PDF-1.7");
    writeFileSync(join(root, "notes.md"), "# Notes\n");
    const outside = tempDir("realm-review-outside-");
    writeFileSync(join(outside, "elsewhere.png"), "png");
    symlinkSync(outside, join(root, "linked"));
    const items: TeamReviewItem[] = [
      { id: "email", reviewId: "r1", version: 1, ord: 1, files: [], body: "Hi Dana,\n\nIt ships Friday.", target: null, contentHash: "h", approvedHash: null, actState: "none",
        meta: { subject: "It ships Friday" }, action: { connector: "mcp:gmail", verb: "email", to: "dana@acme.com" } },
      { id: "post", reviewId: "r1", version: 1, ord: 0, files: ["renders/toggle.png", "brief.pdf", "linked/elsewhere.png"], body: "Dark mode is here.",
        target: { channel: "instagram", account: "@realm" }, contentHash: "h", approvedHash: null, actState: "none" },
      { id: "doc", reviewId: "r1", version: 1, ord: 2, files: ["notes.md"], body: null, target: null, contentHash: "h", approvedHash: null, actState: "none" },
    ];
    const detail = { ...review("r1", "s1", "waiting", 300), items, previous: [], costUsd: null, durationMs: null, runCapUsd: null, model: null, recordName: null,
      checks: [], ledger: [], root, tickets: [], fileTexts: { "notes.md": "# Notes\n" }, why: null } satisfies TeamReviewDetail;
    const decided = (state: TeamReviewSummary["state"]) => (p: { note?: string; reason?: string }) => ({ ...review("r1", "s1", state, 400), note: p.note ?? p.reason ?? null });
    const { rpc, asked } = recorded({ sessions: [], items: [] }, {
      "team.review": ((p: { id: string }) => { if (p.id !== "r1") throw new RpcCallError("NOT_FOUND", `review ${p.id} not found`); return detail; }) as never,
      "team.reviewApprove": decided("approved") as never, "team.reviewRequestChanges": decided("changes") as never, "team.reviewReject": decided("rejected") as never,
    });
    return { rpc, asked, root, outside };
  }

  it("reads a review's drafts in their order as text, each picture by its path in the space's folder", async () => {
    const { rpc, root } = rig();
    const got = await attempt(api(), rpc, "review.get", { id: "r1" });
    if (!got.ok) throw new Error(got.message);
    const { review: summary, items } = MobileCalls["review.get"].result.parse(got.result);
    expect(summary).toMatchObject({ id: "r1", spaceName: "Space s1", state: "waiting" });
    expect(items.map((i) => [i.id, i.title, i.body, i.channel, i.to])).toEqual([
      ["post", null, "Dark mode is here.", "instagram", null],
      // An email's subject is its title, whichever way its key is written; its recipient is its action's.
      ["email", "It ships Friday", "Hi Dana,\n\nIt ships Friday.", null, "dana@acme.com"],
      // A document with no words of its own is the text of its file.
      ["doc", null, "# Notes\n", null, null],
    ]);
    // Pictures only: the PDF goes with the post, but a phone is shown its pictures.
    expect(items[0]!.files).toEqual([
      { path: join(root, "renders/toggle.png"), name: "toggle.png", mime: "image/png" },
      { path: join(root, "linked/elsewhere.png"), name: "elsewhere.png", mime: "image/png" },
    ]);
  });

  it("decides by the desktop's own calls, and asks for changes only with a note saying what", async () => {
    const { rpc, asked } = rig();
    expect(await attempt(api(), rpc, "review.decide", { id: "r1", decision: "approve", note: "ignored" })).toMatchObject({ ok: true, result: { review: { state: "approved", spaceName: "Space s1" } } });
    // THE MUTANT: hand the desktop an empty note, which it refuses in words meant for a role ("say what should change").
    for (const note of [undefined, "   "]) {
      expect(await attempt(api(), rpc, "review.decide", { id: "r1", decision: "changes", ...(note === undefined ? {} : { note }) })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    }
    expect(await attempt(api(), rpc, "review.decide", { id: "r1", decision: "changes", note: " Shorter, please " })).toMatchObject({ ok: true, result: { review: { state: "changes", note: "Shorter, please" } } });
    expect(await attempt(api(), rpc, "review.decide", { id: "r1", decision: "reject", note: "Not this week" })).toMatchObject({ ok: true, result: { review: { state: "rejected", note: "Not this week" } } });
    await attempt(api(), rpc, "review.decide", { id: "r1", decision: "reject" });
    expect(asked.filter(([m]) => m !== "team.review")).toEqual([
      ["team.reviewApprove", { id: "r1" }], ["team.reviewRequestChanges", { id: "r1", note: "Shorter, please" }],
      ["team.reviewReject", { id: "r1", reason: "Not this week" }], ["team.reviewReject", { id: "r1" }],
    ]);
  });

  it("passes on, in the Mac's words, a decision the review's state refuses", async () => {
    const rpc = fakeRpc({ sessions: [], items: [] }, {
      "team.reviewApprove": (() => { throw new RpcCallError("TEAM_REVIEW_STATE", "this review is approved, not waiting"); }) as never,
    });
    expect(await attempt(api(), rpc, "review.decide", { id: "r1", decision: "approve" })).toEqual({ ok: false, code: "FORBIDDEN", message: "this review is approved, not waiting" });
  });

  it("previews only a picture the review's items carry, and only while it is inside its space's folder", async () => {
    const { rpc, root, outside } = rig();
    expect(await attempt(api(async () => Buffer.from("jpeg")), rpc, "review.file", { id: "r1", path: join(root, "renders/toggle.png") }))
      .toMatchObject({ ok: true, result: { name: "toggle.png", preview: { kind: "image", mime: "image/jpeg" } } });
    // Not a picture, not one an item carries, nor any other review's.
    for (const [path, id] of [[join(root, "brief.pdf"), "r1"], [join(root, "notes.md"), "r1"], [join(outside, "elsewhere.png"), "r1"], ["/etc/hosts", "r1"]] as const) {
      expect(await attempt(api(), rpc, "review.file", { id, path }), path).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await attempt(api(), rpc, "review.file", { id: "r2", path: join(root, "renders/toggle.png") })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // THE MUTANT: trust the listed path, and a folder linked in since leads the preview out of the space.
    expect(await attempt(api(async () => { throw new Error("must not be read"); }), rpc, "review.file", { id: "r1", path: join(root, "linked/elsewhere.png") }))
      .toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("Scheduled", () => {
  const schedule = (id: string, spaceId: string, cron: string, extra: Partial<Schedule> = {}): Schedule => ({
    id, spaceId, title: id, goal: id, cron, enabled: true, constraints: null, nextRunAt: null, lastRunAt: null, lastRunId: null, lastSkippedAt: null,
    newSessionPerRun: true, archiveSucceeded: false, roleId: null, createdAt: 0, updatedAt: 0, ...extra,
  });
  const run = (id: string, state: Run["state"], sessionId: string | null): Run => ({
    id, spaceId: "s1", title: id, goal: id, agentKind: "claude", environmentId: null, constraints: null, dedupeKey: null, state, attempt: 1, maxAttempts: 1, sessionId,
    scheduleId: null, roleId: null, wokeOn: null, costUsd: null, deadlineAt: null, result: null, error: null, createdAt: 0, startedAt: 0, settledAt: null, updatedAt: 0,
  });
  const tasks: Record<string, Schedule[]> = {
    s1: [
      schedule("later", "s1", "0 16 * * 5", { nextRunAt: 3_000, lastRunId: "never-read", lastRunAt: 50 }),
      schedule("paused", "s1", "0 9 * * 1-5", { enabled: false, nextRunAt: 1_000, lastRunId: "failed", lastRunAt: 40, createdAt: 5 }),
    ],
    s2: [
      schedule("sooner", "s2", "15 * * * *", { nextRunAt: 2_000, lastRunId: "read", lastRunAt: 60 }),
      schedule("deleted-run", "s2", "0 9 1 * *", { lastRunId: "gone", lastRunAt: 30, createdAt: 9 }),
      schedule("asks", "s2", "0 8 * * *", { nextRunAt: 2_500, lastRunId: "blocked", lastRunAt: 70 }),
    ],
  };
  const runs: Record<string, Run> = {
    "never-read": run("never-read", "succeeded", "run-1"), read: run("read", "succeeded", "run-2"), failed: run("failed", "failed", null),
    blocked: run("blocked", "blocked", "run-3"), now: run("now", "queued", null),
  };
  const rig = () => recorded({
    sessions: [session("run-1", "s1", { lastEventSeq: 9, seenSeq: 0 }), session("run-2", "s2", { lastEventSeq: 9, seenSeq: 9 }), session("run-3", "s2", { lastEventSeq: 4, seenSeq: 2 })],
    items: [],
  }, {
    "schedules.list": ((p: { spaceId: string }) => tasks[p.spaceId] ?? []) as never,
    "runs.get": ((p: { id: string }) => (runs[p.id] ? { run: runs[p.id], attempts: [] } : null)) as never,
    "schedules.runNow": ((p: { id: string }) => {
      if (p.id === "busy") throw new RpcCallError("SCHEDULE_BUSY", "this task continues one session, and its last run is still going");
      return { ...tasks.s1![0]!, lastRunId: "now", lastRunAt: 100 };
    }) as never,
  });

  it("lists every space's tasks in the Scheduled page's order, in its words, with how each last run went", async () => {
    const got = await attempt(api(), rig().rpc, "schedules.list", {});
    if (!got.ok) throw new Error(got.message);
    const { tasks: listed } = MobileCalls["schedules.list"].result.parse(got.result);
    // What runs next first; then what is paused or has nothing left to run, the newest of those first.
    expect(listed.map((t) => [t.id, t.spaceName, t.when])).toEqual([
      ["sooner", "Space s2", "Every hour at :15"], ["asks", "Space s2", "Every day at 8:00 AM"], ["later", "Space s1", "Fridays at 4:00 PM"],
      ["deleted-run", "Space s2", "The 1st of every month at 9:00 AM"], ["paused", "Space s1", "Weekdays at 9:00 AM"],
    ]);
    // THE MUTANT: the sidebar's unread rule, which reads a session nobody ever opened as read — and a
    // run a clock started while nobody looked has no dot.
    expect(Object.fromEntries(listed.map((t) => [t.id, t.lastRun]))).toEqual({
      sooner: { state: "Finished", sessionId: "run-2", unread: false },
      asks: { state: "Needs you", sessionId: "run-3", unread: true },
      later: { state: "Finished", sessionId: "run-1", unread: true },
      // A run deleted since is no run to say anything of.
      "deleted-run": null,
      paused: { state: "Failed", sessionId: null, unread: false },
    });
    expect(listed.find((t) => t.id === "paused")).toMatchObject({ enabled: false, nextRunAt: 1_000, lastRunAt: 40 });
  });

  it("runs a task now as the desktop's Run now does, and answers with the run it started", async () => {
    const { rpc, asked } = rig();
    expect(await attempt(api(), rpc, "schedules.runNow", { id: "later" })).toEqual({ ok: true, result: { task: {
      id: "later", spaceId: "s1", spaceName: "Space s1", title: "later", when: "Fridays at 4:00 PM", enabled: true, nextRunAt: 3_000, lastRunAt: 100,
      lastRun: { state: "Starting", sessionId: null, unread: false },
    } } });
    expect(asked.filter(([m]) => m === "schedules.runNow")).toEqual([["schedules.runNow", { id: "later" }]]);
    // A task whose last run is still going says why it will not start another, in the Mac's words.
    expect(await attempt(api(), rpc, "schedules.runNow", { id: "busy" })).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.stringContaining("still going") });
  });
});

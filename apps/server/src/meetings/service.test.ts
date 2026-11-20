import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAdapter, type AgentAdapter, type FakeScript, type ProbeResult, type StartOptions } from "@realm/adapters";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); vi.restoreAllMocks(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => ws.close() };
}

class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(opts: StartOptions) { this.starts.push(opts); return super.start(opts); }
}

const ANSWER = "## Summary\nThe launch moved to the ninth.\n\n## Decisions\n- Launch on the ninth.\n\n## Action items\nNone";
const answers = (emit: FakeScript[number]["emit"]): FakeScript => [{ on: "You are writing the notes for a meeting", emit }];

const STARTED = new Date(2026, 10, 20, 14, 5).getTime();
const LINES = [
  { source: "me", text: "shall we move the launch", start: 0, end: 2_000, at: STARTED },
  { source: "them", text: "yes, to the", start: 4_000, end: 5_000, at: STARTED + 4_000 },
  { source: "them", text: "ninth of December", start: 6_000, end: 7_500, at: STARTED + 6_000 },
];
const TRANSCRIPT = "## Transcript\n\n**Me** (0:00) shall we move the launch\n\n**Them** (0:04) yes, to the ninth of December\n";

async function boot(script: FakeScript, adapters?: Record<string, AgentAdapter>) {
  const home = tempDir("realm-");
  const fake = new RecordingFake({ script });
  app = await createApp({ home, port: 0, adapters: adapters ?? { fake } });
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  const root = (await c.call("documents.spaceRoot", { spaceId: space.id })).result.root as string;
  const meeting = (over: Record<string, unknown> = {}) => ({
    meetingId: "m1", spaceId: space.id, title: "Launch sync", startedAt: STARTED, endedAt: STARTED + 32 * 60_000,
    lines: LINES, notes: "- ask about pricing", customInfo: "They are the supplier.", ...over,
  });
  const save = async (over: Record<string, unknown> = {}) => (await c.call("meetings.saveNotes", meeting(over))).result;
  const fileAt = (path: string) => readFileSync(join(root, path), "utf8");
  const progress = () => c.events.filter((e) => e.event === "meetings.notesProgress").map((e) => e.payload);
  return { home, fake, c, space, root, meeting, save, fileAt, progress };
}

describe("meetings.saveNotes", () => {
  it("writes one file with the summary, decisions, action items, notes and transcript", async () => {
    const { save, fileAt, fake } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const saved = await save();
    expect(saved).toEqual({ path: "meetings/2026-11-20 1405 Launch sync.md", summary: "written" });
    expect(fileAt(saved.path)).toBe(`# Launch sync

2026-11-20 14:05 · 32 min

## Summary

The launch moved to the ninth.

## Decisions

- Launch on the ninth.

## Action items

No action items were recorded.

## Notes

- ask about pricing

${TRANSCRIPT}`);
    // The model was sent the transcript, the notes and the custom info.
    expect(fake.starts).toHaveLength(1);
  });

  it("has the notes and the transcript on disk before the model answers, and says where it has got to", async () => {
    const { c, save, fileAt, progress, space } = await boot(answers([{ kind: "text", text: ANSWER, paceMs: 15 }]));
    const saving = save();
    await waitFor(() => progress().length === 1);
    const path = "meetings/2026-11-20 1405 Launch sync.md";
    expect(progress()).toEqual([{ meetingId: "m1", spaceId: space.id, path, stage: "summarising" }]);
    const early = fileAt(path);
    expect(early).toContain("## Summary\n\nThe summary has not been written.\n\n## Notes\n\n- ask about pricing\n");
    expect(early.endsWith(TRANSCRIPT)).toBe(true);
    await saving;
    expect(progress().map((p) => p.stage)).toEqual(["summarising", "saved"]);
    expect(fileAt(path)).toContain("The launch moved to the ninth.");
    c.close();
  });

  it("gives a second meeting in the same minute its own file and leaves the first alone", async () => {
    const { save, fileAt, root } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const first = await save();
    const before = fileAt(first.path);
    const second = await save({ meetingId: "m2", notes: "the second meeting's notes" });
    const third = await save({ meetingId: "m3" });
    expect([second.path, third.path]).toEqual(["meetings/2026-11-20 1405 Launch sync (2).md", "meetings/2026-11-20 1405 Launch sync (3).md"]);
    expect(fileAt(first.path)).toBe(before);
    expect(fileAt(second.path)).toContain("the second meeting's notes");
    expect(readdirSync(join(root, "meetings")).sort()).toEqual(["2026-11-20 1405 Launch sync (2).md", "2026-11-20 1405 Launch sync (3).md", "2026-11-20 1405 Launch sync.md"]);
  });

  it("gives two meetings saved at the same moment a file each", async () => {
    const { save, fileAt } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const [a, b] = await Promise.all([save({ meetingId: "a", notes: "notes a" }), save({ meetingId: "b", notes: "notes b" })]);
    expect(new Set([a.path, b.path]).size).toBe(2);
    expect([fileAt(a.path).includes("notes a"), fileAt(b.path).includes("notes b")]).toEqual([true, true]);
  });

  it("names the file safely whatever the title holds, and keeps the title as written in the file", async () => {
    const { save, fileAt, root } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const saved = await save({ title: "Q4/Q1 plan: go 🚀 or no-go?" });
    expect(saved.path).toBe("meetings/2026-11-20 1405 Q4 Q1 plan go 🚀 or no-go.md");
    expect(fileAt(saved.path).startsWith("# Q4/Q1 plan: go 🚀 or no-go?\n")).toBe(true);
    expect(readdirSync(join(root, "meetings"))).toEqual(["2026-11-20 1405 Q4 Q1 plan go 🚀 or no-go.md"]);
    expect((await save({ meetingId: "m2", title: "../../outside" })).path).toBe("meetings/2026-11-20 1405 outside.md");
  });

  it("calls a meeting with no title Meeting", async () => {
    const { c, meeting } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const { title: _title, ...untitled } = meeting();
    expect((await c.call("meetings.saveNotes", untitled)).result.path).toBe("meetings/2026-11-20 1405 Meeting.md");
  });

  it("keeps the notes and transcript, with one line for the summary, when the model call fails", async () => {
    const { save, fileAt, progress } = await boot(answers([{ kind: "fail", message: "usage limit reached" }]));
    const saved = await save();
    expect(saved.summary).toBe("failed");
    const text = fileAt(saved.path);
    expect(text).toContain("## Summary\n\nThe summary could not be written: usage limit reached.\n\n## Notes\n\n- ask about pricing\n");
    expect(text.endsWith(TRANSCRIPT)).toBe(true);
    expect(text.match(/^## .*$/gm)).toEqual(["## Summary", "## Notes", "## Transcript"]);
    expect(progress().map((p) => p.stage)).toEqual(["summarising", "saved"]);
  });

  it("does the same when the model answers with no summary", async () => {
    const { save, fileAt } = await boot(answers([{ kind: "text", text: "I cannot help with that." }]));
    const saved = await save();
    expect(saved.summary).toBe("failed");
    expect(fileAt(saved.path)).toContain("## Summary\n\nThe summary could not be written: the model's answer had no summary in it.\n\n## Notes");
    expect(fileAt(saved.path).endsWith(TRANSCRIPT)).toBe(true);
  });

  it("keeps the notes and transcript when the summary is cancelled", async () => {
    const { c, save, fileAt, progress } = await boot(answers([{ kind: "text", text: ANSWER, paceMs: 40 }]));
    expect((await c.call("meetings.cancelSummary", { meetingId: "m1" })).result).toEqual({ cancelled: false });
    const saving = save();
    await waitFor(() => progress().length === 1);
    expect((await c.call("meetings.cancelSummary", { meetingId: "m1" })).result).toEqual({ cancelled: true });
    const saved = await saving;
    expect(saved.summary).toBe("cancelled");
    const text = fileAt(saved.path);
    expect(text).toContain("## Summary\n\nThe summary could not be written: it was cancelled.\n\n## Notes\n\n- ask about pricing\n");
    expect(text.endsWith(TRANSCRIPT)).toBe(true);
    expect((await c.call("meetings.cancelSummary", { meetingId: "m1" })).result).toEqual({ cancelled: false });
  });

  it("keeps the notes and transcript when no model is signed in, and starts no agent", async () => {
    class SignedOut extends RecordingFake {
      override async probe(): Promise<ProbeResult> { return { kind: "fake", available: true, version: "1", loggedIn: false, reason: "not signed in" }; }
    }
    const signedOut = new SignedOut({ script: answers([{ kind: "text", text: ANSWER }]) });
    const { c, save, fileAt } = await boot([], { fake: signedOut });
    await c.call("agents.probe", { force: true });
    const saved = await save();
    expect(saved.summary).toBe("unavailable");
    const text = fileAt(saved.path);
    expect(text).toContain("## Summary\n\nThe summary could not be written: the Quick chat model is not signed in.\n\n## Notes\n\n- ask about pricing\n");
    expect(text.endsWith(TRANSCRIPT)).toBe(true);
    expect(signedOut.starts).toEqual([]);
  });

  it("asks no model about a meeting where nothing was said or noted", async () => {
    const { save, fileAt, fake, progress } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const saved = await save({ lines: [{ source: "me", text: "  ", start: 0, end: 10, at: STARTED }], notes: "" });
    expect(saved.summary).toBe("empty");
    expect(fileAt(saved.path)).toBe(`# Launch sync

2026-11-20 14:05 · 32 min

## Summary

Nothing was said or noted, so there is no summary.

## Notes

No notes were taken.

## Transcript

Nothing was transcribed.
`);
    expect(fake.starts).toEqual([]);
    expect(progress().map((p) => p.stage)).toEqual(["saved"]);
  });

  it("summarises notes taken in a meeting with no transcript", async () => {
    const { save, fileAt } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const saved = await save({ lines: [] });
    expect(saved.summary).toBe("written");
    expect(fileAt(saved.path)).toContain("The launch moved to the ninth.");
    expect(fileAt(saved.path).endsWith("## Transcript\n\nNothing was transcribed.\n")).toBe(true);
  });

  it("writes a summary holding a replacement pattern as text", async () => {
    const { save, fileAt } = await boot(answers([{ kind: "text", text: "## Summary\nThe price is $& or $1 or $`." }]));
    const saved = await save();
    expect(fileAt(saved.path)).toContain("## Summary\n\nThe price is $& or $1 or $`.\n\n## Decisions");
  });

  it("leaves a file the person edited while the model wrote as they have it", async () => {
    const { save, root, progress, fileAt } = await boot(answers([{ kind: "text", text: ANSWER, paceMs: 15 }]));
    const saving = save();
    await waitFor(() => progress().length === 1);
    writeFileSync(join(root, progress()[0].path), "my own rewrite\n");
    const saved = await saving;
    expect(fileAt(saved.path)).toBe("my own rewrite\n");
  });

  it("refuses a space that does not exist, and writes nothing", async () => {
    const { c, meeting, root } = await boot([]);
    const refused = await c.call("meetings.saveNotes", meeting({ spaceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }));
    expect(refused.ok).toBe(false);
    expect(readdirSync(root)).not.toContain("meetings");
  });

  it("shows up in the space's Documents list and reads back through it", async () => {
    const { c, save, space } = await boot(answers([{ kind: "text", text: ANSWER }]));
    const before = (await c.call("documents.listInSpace", { spaceId: space.id })).result.entries;
    expect(before.map((e: Any) => e.path)).not.toContain("meetings");
    const saved = await save();
    const listed = (await c.call("documents.listInSpace", { spaceId: space.id, dir: "meetings" })).result.entries;
    expect(listed.map((e: Any) => e.path)).toEqual([saved.path]);
    const opened = (await c.call("documents.openPath", { spaceId: space.id, path: saved.path })).result;
    expect((await c.call("documents.read", { documentsId: opened.documentsId, path: saved.path })).result.text).toContain("ninth of December");
  });
});

describe("meetings.list", () => {
  it("lists the meetings' Markdown files, the newest meeting first, and nothing for a space with none", async () => {
    const { c, save, space, root } = await boot(answers([{ kind: "text", text: ANSWER }]));
    expect((await c.call("meetings.list", { spaceId: space.id })).result).toEqual({ notes: [] });
    const earlier = await save({ meetingId: "a", title: "Standup", startedAt: STARTED - 86_400_000, endedAt: STARTED - 86_000_000 });
    const later = await save({ meetingId: "b" });
    writeFileSync(join(root, "meetings", ".hidden.md"), "x");
    writeFileSync(join(root, "meetings", "recording.txt"), "x");
    const { notes } = (await c.call("meetings.list", { spaceId: space.id })).result;
    expect(notes.map((n: Any) => n.path)).toEqual([later.path, earlier.path]);
    expect(notes.every((n: Any) => n.modifiedAt > STARTED)).toBe(true);
  });
});

describe("words only", () => {
  it("keeps the transcript, the notes, the title and the custom info out of the database and the log", async () => {
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "info"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args.join(" ")); });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { logged.push(String(chunk)); return true; });
    const { home, save, root } = await boot(answers([{ kind: "fail", message: "usage limit reached" }]));
    await save({ title: "Zebra quarterly", notes: "ask about the aardvark", customInfo: "They are the platypus supplier." });
    await save({ meetingId: "m2", title: "Zebra quarterly" });
    stderr.mockRestore();

    const secrets = ["ninth of December", "move the launch", "Zebra", "aardvark", "platypus"];
    const holding = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => { const bytes = readFileSync(file).toString("latin1"); return secrets.some((s) => bytes.includes(s)); });
    expect(holding(home).filter((file) => !file.startsWith(join(root, "meetings")))).toEqual([]);
    expect(holding(join(root, "meetings"))).toHaveLength(2);
    expect(logged.filter((entry) => secrets.some((s) => entry.includes(s)))).toEqual([]);
  });
});

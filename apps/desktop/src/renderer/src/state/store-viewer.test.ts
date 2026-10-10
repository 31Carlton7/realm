import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, sessionEvent } from "@realm/contracts";
import { createAppStore } from "./store";
import { fakeApi, item, session } from "./store.test-fakes";
import { VIEWER_SLOT, exchangeResults, exchangeStart, ownerOf, viewerStartSpace } from "./viewer";
import { reduceAll } from "../panes/session/transcript-model";
import { keyContext } from "../keys/commands";

/**
 * The media viewer's state: what it shows, whom its prompter asks, and what a question sends. Every
 * test names the one-line change that would make it fail.
 */

type Store = ReturnType<typeof createAppStore>;

async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Logo rework" })] },
    sessions: [session("lead", "s1", { title: "Logo rework", cwd: "/work/logo" })],
    ...over,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  return { api, store };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const viewer = (store: Store) => store.getState().viewer!;

describe("opening the viewer", () => {
  it("asks the session the media came from, and loads that session's transcript to draw the exchange from", async () => {
    // THE MUTANT: skip `holdViewerSession` — a Library file's session is open in no pane, so the
    // exchange would have no transcript to be read off and the answer would never appear.
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/work/logo/hero.png" }], sessionId: "lead" });
    expect(viewer(store)).toMatchObject({ sessionId: "lead", spaceId: "s1", index: 0, thread: null });
    await settle();
    expect(api.calls).toContain("sessionEvents:lead:0");
    expect(store.getState().transcripts["lead"]).toBeDefined();
  });

  it("asks nobody for a session that is gone, rather than a prompter that cannot send", async () => {
    // THE MUTANT: keep `input.sessionId` as given. A Library file outlives the session that made it,
    // and a send to a deleted session is an error after the question has been typed.
    const { store } = await mount();
    store.getState().openViewer({ files: [{ path: "/x/a.png" }], sessionId: "deleted", spaceId: "s2" });
    expect(viewer(store)).toMatchObject({ sessionId: null, spaceId: "s2" });
  });

  it("walks its siblings and stops at the ends", async () => {
    const { store } = await mount();
    store.getState().openViewer({ files: [{ path: "/a.png" }, { path: "/b.png" }, { path: "/c.png" }], index: 1 });
    store.getState().stepViewer(1);
    expect(viewer(store).index).toBe(2);
    // THE MUTANT: wrap round to the first. The list is the one the eye just walked, and it ends.
    store.getState().stepViewer(1);
    expect(viewer(store).index).toBe(2);
    store.getState().stepViewer(-1); store.getState().stepViewer(-1); store.getState().stepViewer(-1);
    expect(viewer(store).index).toBe(0);
  });

  it("puts what the exchange produced right after the file on show, and moves to it", async () => {
    const { store } = await mount();
    store.getState().openViewer({ files: [{ path: "/a.png" }, { path: "/b.png" }], index: 0 });
    store.getState().addViewerFiles(["/a-warm.png", "/a.png"], true);
    // The original stays one step back; a path already listed is not listed twice.
    expect(viewer(store).files.map((f) => f.path)).toEqual(["/a.png", "/a-warm.png", "/b.png"]);
    expect(viewer(store).index).toBe(1);
  });

  it("puts the marks on one file away when another is shown — they are that file's", async () => {
    const { store } = await mount();
    store.getState().openViewer({ files: [{ path: "/a.png" }, { path: "/b.png" }] });
    store.getState().setViewerMarks({ path: "/a.png", natural: { w: 10, h: 10 }, marks: [{ points: [[1, 1]], width: 2 }], drawing: true });
    store.getState().stepViewer(1);
    expect(viewer(store).marking).toBeNull();
  });

  it("owns the keyboard while it is up, so a chord meant for a pane does not act on one behind it", async () => {
    // ⌘W, ⌘\, ⌘1…9 are `!overlayOpen` chords. THE MUTANT: leave the viewer out of `overlayOpen`, and
    // ⌘W closes a pane nobody can see — or ⌘2 switches the space out from under the file.
    const { store } = await mount();
    expect(keyContext(store.getState(), null).overlayOpen).toBe(false);
    store.getState().openViewer({ files: [{ path: "/a.png" }] });
    expect(keyContext(store.getState(), null).overlayOpen).toBe(true);
  });

  it("closes on a profile switch, which takes the workspace it was looking at with it", async () => {
    const { store } = await mount();
    store.getState().openViewer({ files: [{ path: "/a.png" }] });
    await store.getState().selectProfile("p2");
    expect(store.getState().viewer).toBeNull();
  });
});

describe("asking about the file", () => {
  it("sends to the session the file came from, carrying the file through the attachment wire", async () => {
    // THE MUTANT: name the path in the text instead of attaching it — the agent would get a string
    // where every adapter's contract is an attachment (an inlined image, a handed-over path).
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/work/logo/hero.png" }], sessionId: "lead" });
    await store.getState().sendFromViewer("Make the sky warmer");
    expect(api.sent.at(-1)).toEqual({ id: "lead", text: "Make the sky warmer", attachments: [{ path: "/work/logo/hero.png", mime: "image/png" }] });
    expect(viewer(store).thread).toMatchObject({ sessionId: "lead", from: 0 });
  });

  it("carries files dropped on its prompter after the viewed one, and empties them once they went", async () => {
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/work/logo/hero.png" }], sessionId: "lead" });
    store.getState().attachPicked(VIEWER_SLOT, [{ path: "/ref/palette.png", mime: "image/png", name: "palette.png", size: 10 }]);
    await store.getState().sendFromViewer("Use these colours");
    expect(api.sent.at(-1)!.attachments.map((a) => a.path)).toEqual(["/work/logo/hero.png", "/ref/palette.png"]);
    expect(store.getState().pendingAttachments[VIEWER_SLOT]).toEqual([]);
    // …and never the session's OWN prompter's chips, which are a different message.
    expect(store.getState().pendingAttachments["lead"] ?? []).toEqual([]);
  });

  it("leaves the file off a message it was taken off, and puts it back for the next", async () => {
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/work/logo/hero.png" }], sessionId: "lead" });
    store.getState().detachViewerFile("/work/logo/hero.png");
    await store.getState().sendFromViewer("Unrelated: what time is it?");
    expect(api.sent.at(-1)!.attachments).toEqual([]);
    await store.getState().sendFromViewer("And this one?");
    expect(api.sent.at(-1)!.attachments).toHaveLength(1);
  });

  it("refuses only what would be refused anyway: an inlined image over the cap, with the sentence why", async () => {
    // A fake of main that says the file is big. Claude inlines images, so this one cannot go.
    const { api, store } = await mount({ sessions: [session("lead", "s1", { agentKind: "claude" })] });
    api.describePaths = async (paths) => paths.map((path) => ({ path, mime: "image/png", name: "huge.png", size: MAX_ATTACHMENT_BYTES + 1 }));
    store.getState().openViewer({ files: [{ path: "/huge.png" }], sessionId: "lead" });
    await store.getState().sendFromViewer("What is this?");
    expect(api.sent.at(-1)!.attachments).toEqual([]);
    expect(store.getState().toasts.at(-1)?.text).toMatch(/Too large to attach/);
    // THE MUTANT: apply the cap to every kind. A long video handed over as a PATH has no such limit.
    api.describePaths = async (paths) => paths.map((path) => ({ path, mime: "video/mp4", name: "long.mp4", size: MAX_ATTACHMENT_BYTES * 4 }));
    store.getState().openViewer({ files: [{ path: "/long.mp4" }], sessionId: "lead" });
    await store.getState().sendFromViewer("Trim the start");
    expect(api.sent.at(-1)!.attachments).toEqual([{ path: "/long.mp4", mime: "video/mp4" }]);
  });

  it("starts a session in the file's own space when there is nobody to ask, and keeps asking that one", async () => {
    // THE MUTANTS: make the session at OPEN (a session per look is litter), or make a second one on
    // the second question.
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/x/orphan.png", from: { sessionId: "deleted", spaceId: "s2", sessionTitle: "Gone", kind: "output" } }] });
    expect(api.calls.some((c) => c.startsWith("createSession:"))).toBe(false);
    await store.getState().sendFromViewer("What is this?");
    const made = api.calls.filter((c) => c.startsWith("createSession:"));
    expect(made).toHaveLength(1);
    const sid = viewer(store).sessionId!;
    expect(store.getState().sessions[sid]?.spaceId).toBe("s2");
    expect(api.calls).toContain("listItems:s2"); // its row, for the sidebar
    await store.getState().sendFromViewer("And again?");
    expect(api.calls.filter((c) => c.startsWith("createSession:"))).toHaveLength(1);
    expect(api.sent.map((m) => m.id)).toEqual([sid, sid]);
  });

  it("starts that session on the agent and model picked in the viewer's own prompter", async () => {
    const { api, store } = await mount();
    store.getState().openViewer({ files: [{ path: "/x/a.png" }], spaceId: "s1" });
    store.getState().pickViewerAgent("codex", "gpt-6-luna");
    await store.getState().sendFromViewer("hi");
    expect(api.calls).toContain("createSession:codex");
    expect(store.getState().sessions[viewer(store).sessionId!]?.model).toBe("gpt-6-luna");
  });

  it("asks a Library file's own session about it, file by file", async () => {
    // Walking the Library's page moves the prompter to whichever session made the file on show.
    const { api, store } = await mount({
      sessions: [session("lead", "s1", { title: "Logo rework" }), session("other", "s2", { title: "Banner" })],
      items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead" })], s2: [item("i-other", "s2", { kind: "session", refId: "other" })] },
    });
    await store.getState().refreshAllSessions();
    const from = (sessionId: string, spaceId: string) => ({ sessionId, spaceId, sessionTitle: sessionId, kind: "output" as const });
    store.getState().openViewer({ files: [{ path: "/a.png", from: from("lead", "s1") }, { path: "/b.png", from: from("other", "s2") }] });
    await store.getState().sendFromViewer("one");
    store.getState().stepViewer(1);
    await store.getState().sendFromViewer("two");
    expect(api.sent.map((m) => [m.id, m.text])).toEqual([["lead", "one"], ["other", "two"]]);
  });
});

describe("the space a first question starts its session in", () => {
  const spaces = [{ id: "s1" }, { id: "s2" }];
  const from = (spaceId: string | null) => ({ sessionId: "gone", spaceId, sessionTitle: null, kind: "output" as const });

  it("is the space the file came from, ahead of the one the viewer was opened over", () => {
    expect(viewerStartSpace({ spaceId: "s1" }, { path: "/a", from: from("s2") }, spaces, "s1")).toBe("s2");
  });

  it("is the space the viewer was opened over for a file that names none", () => {
    expect(viewerStartSpace({ spaceId: "s2" }, { path: "/a" }, spaces, "s1")).toBe("s2");
    expect(viewerStartSpace({ spaceId: "s2" }, { path: "/a", from: from(null) }, spaces, "s1")).toBe("s2");
  });

  it("is the space on screen where the space the file came from is gone", () => {
    expect(viewerStartSpace({ spaceId: "s1" }, { path: "/a", from: from("s7") }, spaces, "s2")).toBe("s2");
  });

  it("is the space on screen where nothing names another", () => {
    expect(viewerStartSpace({ spaceId: null }, { path: "/a" }, spaces, "s1")).toBe("s1");
  });

  it("is none where no space is on screen either, so nothing is started", () => {
    expect(viewerStartSpace({ spaceId: null }, { path: "/a" }, spaces, null)).toBeNull();
  });
});

describe("the exchange's own part of the transcript", () => {
  const t = reduceAll([
    sessionEvent("user_message", { text: "earlier", attachments: [] }),
    sessionEvent("assistant_text", { messageId: "m0", text: "an earlier turn" }),
    sessionEvent("user_message", { text: "Make the sky warmer", attachments: [] }),
    sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "out/hero-v2.svg" }, parentToolUseId: null }),
    sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false }),
    sessionEvent("tool_call", { toolUseId: "t2", name: "Write", input: { file_path: "/tmp/failed.png" }, parentToolUseId: null }),
    sessionEvent("tool_result", { toolUseId: "t2", content: "denied", isError: true }),
    sessionEvent("assistant_text", { messageId: "m1", text: "Saved the warmer one as `hero-warm.png`." }),
  ]);

  /** Where the second question sits — read off the blocks, so the reducer is free to put a line of
   *  its own between a question and its answer. */
  const second = t.blocks.findIndex((b, i) => i > 0 && b.kind === "user");

  it("starts at the first question at or after its mark, never in the turn that was running", () => {
    expect(exchangeStart(t.blocks, 0)).toBe(0);
    // A send queued behind a turn: the mark is before the turn's own output, the exchange after it.
    expect(exchangeStart(t.blocks, 1)).toBe(second);
    expect(exchangeStart(t.blocks, t.blocks.length)).toBe(-1);
    // A transcript still loading when the question went: no count to trust, and the clock says
    // which question came after it. THE MUTANT: drop the time — the first question ever asked in the
    // session would open this viewer's exchange.
    const asked = t.blocks[second]!.ts;
    const earlier = t.blocks.map((b, i) => (i === 0 ? { ...b, ts: asked - 5000 } : b));
    expect(exchangeStart(earlier, 0, asked)).toBe(second);
  });

  it("finds what a write made and what the answer named, and not what a failed write would have", () => {
    // THE MUTANT: read the tool result's error flag away — a refused Write made nothing.
    const found = exchangeResults(t.blocks.slice(second), "/work/logo");
    expect(found).toContain("/work/logo/out/hero-v2.svg");
    expect(found).toContain("/work/logo/hero-warm.png");
    expect(found).not.toContain("/tmp/failed.png");
  });

  it("asks a file's own session while it can be reached, and the viewer's otherwise", () => {
    const reach = (id: string) => id === "lead" || id === "made";
    const from = { sessionId: "lead", spaceId: "s1", sessionTitle: "", kind: "output" as const };
    expect(ownerOf({ sessionId: "made" }, { path: "/a", from }, reach)).toBe("lead");
    expect(ownerOf({ sessionId: "made" }, { path: "/a", from: { ...from, sessionId: "gone" } }, reach)).toBe("made");
    expect(ownerOf({ sessionId: null }, { path: "/a" }, reach)).toBeNull();
  });
});

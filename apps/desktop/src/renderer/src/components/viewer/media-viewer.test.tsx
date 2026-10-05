import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mediaUrl, sessionEvent, type MediaFile } from "@realm/contracts";
import { MediaStrip } from "../../panes/session/media/MediaView";
import { resetMediaCache } from "../../panes/session/media/use-media";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";
import { MediaViewer } from "./MediaViewer";
import { MediaSessionContext } from "./open";
import { VIEWER_SLOT } from "../../state/viewer";
import { fitScale, stepZoom, anchoredScroll } from "./zoom";

/**
 * The media viewer as a person meets it: opened from a picture, walked with the arrows, zoomed, and
 * asked about in the prompter docked under it. Every test names the one-line change that would make
 * it fail.
 */

const media = (path: string, kind: MediaFile["kind"] = "image"): MediaFile =>
  ({ path, kind, size: 2048, mime: kind === "video" ? "video/mp4" : "image/png" });

/** The preload bridge: `known` is the media on disk; `stats` answers `files.stat` by path, and a
 *  path it does not name is a file that is there with a modification time of 1. */
function bridge(known: MediaFile[], stats: Record<string, { size: number; mtimeMs: number } | null> = {}) {
  const realm = {
    media: {
      stat: vi.fn(async (c: readonly string[]) => c.map((p) => known.find((f) => f.path === p) ?? null)),
      poster: vi.fn(async () => null), reveal: vi.fn(), open: vi.fn(),
    },
    files: {
      stat: vi.fn(async (path: string) => (path in stats ? stats[path]! && { path, ...stats[path]! } : { path, size: 2048, mtimeMs: 1 })),
      preview: vi.fn(async () => "data:image/png;base64,UEFHRQ=="),
      reveal: vi.fn(async () => true), saveCopy: vi.fn(async () => null), finderIcon: vi.fn(async () => null),
    },
    attachmentThumbnail: vi.fn(async () => null),
    openAttachment: vi.fn(async () => undefined),
  };
  vi.stubGlobal("realm", realm);
  return realm;
}

async function mount(files: MediaFile[], over: FakeData = {}) {
  const api = fakeApi({
    items: { s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Logo rework" })] },
    sessions: [session("lead", "s1", { title: "Logo rework", cwd: "/work" })],
    ...over,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const ui = render(
    <StoreContext.Provider value={store}>
      <MediaSessionContext.Provider value="lead"><MediaStrip files={files} /></MediaSessionContext.Provider>
      <MediaViewer />
    </StoreContext.Provider>,
  );
  return { api, store, ui };
}

const viewerEl = () => screen.queryByRole("dialog");
const stageImg = () => viewerEl()?.querySelector<HTMLImageElement>("img.media-viewer-img") ?? null;
/** jsdom decodes nothing, so a picture's load is told: its own pixels, then the load event. */
const loaded = (img: HTMLImageElement, w = 400, h = 300) => {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  fireEvent.load(img);
};
const prompter = () => within(viewerEl()!).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

beforeEach(() => { resetMediaCache(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("opening a file", () => {
  it("opens a message's picture in the one viewer, by name, and Escape closes it", async () => {
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    expect(await screen.findByRole("dialog", { name: "hero.png" })).toBeInTheDocument();
    // The picture through the media scheme, versioned by its modification time.
    await waitFor(() => expect(stageImg()).toHaveAttribute("src", `${mediaUrl("/work/hero.png")}?v=1`));
    fireEvent.keyDown(prompter(), { key: "Escape" });
    await waitFor(() => expect(viewerEl()).toBeNull());
  });

  it("puts the keyboard in the prompter, so a question can be typed at once", async () => {
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog", { name: "hero.png" });
    expect(document.activeElement).toBe(prompter());
  });

  it("lets an open menu inside it answer its own Escape", async () => {
    // THE MUTANT: drop the open-popup guard. Escape would close the viewer out from under the menu
    // it was meant to close — design.md: Escape answers in mount order.
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    const dialog = await screen.findByRole("dialog", { name: "hero.png" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "More actions" }));
    await screen.findByRole("menu");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(viewerEl()).not.toBeNull();
  });

  it("hides the workspace's own video frames while it is up — a video layer paints over any overlay", async () => {
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog");
    expect(document.body.dataset["mediaViewer"]).toBe("");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.body.dataset["mediaViewer"]).toBeUndefined());
  });
});

describe("walking the siblings", () => {
  const three = [media("/work/a.png"), media("/work/b.png"), media("/work/c.png")];

  it("walks the strip's files with → and ←, and says where it is", async () => {
    bridge(three);
    await mount(three);
    fireEvent.click(await screen.findByRole("button", { name: "Open b.png larger" }));
    const dialog = await screen.findByRole("dialog", { name: "b.png" });
    expect(within(dialog).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.keyDown(prompter(), { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "c.png" })).toBeInTheDocument();
    // At the end the next button is spent, not gone: the same control, saying there is no more.
    expect(within(viewerEl()!).getByRole("button", { name: "Next file" })).toBeDisabled();
    fireEvent.click(within(viewerEl()!).getByRole("button", { name: "Previous file" }));
    expect(await screen.findByRole("dialog", { name: "b.png" })).toBeInTheDocument();
  });

  it("leaves the arrows to the caret once a word is being edited", async () => {
    // THE MUTANT: walk on every arrow. A person fixing a typo in their question would be thrown to
    // another file, and their question with it.
    bridge(three);
    await mount(three);
    fireEvent.click(await screen.findByRole("button", { name: "Open a.png larger" }));
    await screen.findByRole("dialog", { name: "a.png" });
    fireEvent.change(prompter(), { target: { value: "warmer" } });
    fireEvent.keyDown(prompter(), { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "a.png" })).toBeInTheDocument();
  });
});

describe("zooming a picture", () => {
  it("fits, steps with − and +, and the readout goes between fit and actual size", async () => {
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await waitFor(() => expect(stageImg()).not.toBeNull());
    loaded(stageImg()!);
    const zoom = within(screen.getByRole("group", { name: "Zoom" }));
    // jsdom lays nothing out, so the box is empty and fit is the picture's own size.
    expect(zoom.getByRole("button", { name: "100%" })).toBeInTheDocument();
    fireEvent.click(zoom.getByRole("button", { name: "Zoom in" }));
    expect(zoom.getByRole("button", { name: "125%" })).toBeInTheDocument();
    expect(stageImg()).toHaveStyle({ width: "500px", height: "375px" });
    fireEvent.click(zoom.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(zoom.getByRole("button", { name: "Zoom out" }));
    expect(zoom.getByRole("button", { name: "75%" })).toBeInTheDocument();
    fireEvent.click(zoom.getByRole("button", { name: "75%" }));
    expect(zoom.getByRole("button", { name: "100%" })).toBeInTheDocument();
  });

  it("takes + and 0 from the keyboard, but never from a field being typed in", async () => {
    bridge([media("/work/hero.png")]);
    await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await waitFor(() => expect(stageImg()).not.toBeNull());
    loaded(stageImg()!);
    const zoom = within(screen.getByRole("group", { name: "Zoom" }));
    fireEvent.keyDown(prompter(), { key: "+" });
    expect(zoom.getByRole("button", { name: "100%" })).toBeInTheDocument();
    fireEvent.keyDown(viewerEl()!, { key: "+" });
    expect(zoom.getByRole("button", { name: "125%" })).toBeInTheDocument();
    fireEvent.keyDown(viewerEl()!, { key: "0" });
    expect(zoom.getByRole("button", { name: "100%" })).toBeInTheDocument();
  });
});

describe("the zoom arithmetic", () => {
  it("fits inside the box and never blows a small picture up", () => {
    expect(fitScale({ w: 4000, h: 3000 }, { w: 800, h: 600 })).toBe(0.2);
    // THE MUTANT: drop the `1` from the min — an icon fitted to a window is a smear.
    expect(fitScale({ w: 64, h: 64 }, { w: 800, h: 600 })).toBe(1);
  });

  it("always moves a step, from wherever the scale is", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(0.2, 1)).toBe(0.25);
    expect(stepZoom(0.25, -1)).toBe(0.1);
    expect(stepZoom(8, 1)).toBe(8);
  });

  it("keeps the point under the pointer under it", () => {
    // A 1000×1000 picture at 100% in a 500×500 box, scrolled to its middle, zoomed 2× at the centre.
    const s = anchoredScroll({ at: { x: 250, y: 250 }, scroll: { left: 250, top: 250 }, natural: { w: 1000, h: 1000 }, box: { w: 500, h: 500 }, from: 1, to: 2 });
    expect(s).toEqual({ left: 750, top: 750 });
  });
});

describe("files that are not media", () => {
  it("shows a PDF as macOS renders it, at the window's size — and never puts it to the media gate", async () => {
    const realm = bridge([]);
    const { store } = await mount([]);
    act(() => store.getState().openViewer({ files: [{ path: "/work/brief.pdf" }], sessionId: "lead" }));
    await screen.findByRole("dialog", { name: "brief.pdf" });
    await waitFor(() => expect(realm.files.preview).toHaveBeenCalledWith("/work/brief.pdf", "page"));
    await waitFor(() => expect(stageImg()).toHaveAttribute("alt", "Preview of brief.pdf"));
    expect(realm.media.stat).not.toHaveBeenCalled();
  });

  it("says plainly when macOS has no picture of the file, rather than an empty frame", async () => {
    const realm = bridge([]);
    realm.files.preview.mockResolvedValue(null as unknown as string);
    const { store } = await mount([]);
    act(() => store.getState().openViewer({ files: [{ path: "/work/data.bin" }] }));
    expect(await screen.findByText("macOS has no preview for data.bin.")).toBeInTheDocument();
  });

  it("says a file that has gone is gone, and offers nothing that would fail", async () => {
    bridge([], { "/work/gone.png": null });
    const { store } = await mount([]);
    act(() => store.getState().openViewer({ files: [{ path: "/work/gone.png" }] }));
    expect(await screen.findByText("This file is no longer on disk.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal in Finder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("the prompter docked under it", () => {
  async function openAndAsk(over: FakeData = {}, known = [media("/work/hero.png")]) {
    const realm = bridge(known);
    const m = await mount([media("/work/hero.png")], over);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog", { name: "hero.png" });
    fireEvent.change(prompter(), { target: { value: "Make the sky warmer" } });
    fireEvent.keyDown(prompter(), { key: "Enter" });
    await waitFor(() => expect(m.api.sent).toHaveLength(1));
    return { ...m, realm };
  }
  /** The session's agent doing its turn: the question landing, then the answer. */
  const answer = (store: ReturnType<typeof createAppStore>, text: string, seq = 1) => act(() => {
    store.getState().applySessionEvent({ seq, sessionId: "lead", ephemeral: false,
      event: sessionEvent("user_message", { text: "Make the sky warmer", attachments: [{ path: "/work/hero.png", mime: "image/png" }] }) });
    store.getState().applySessionEvent({ seq: seq + 1, sessionId: "lead", ephemeral: false, event: sessionEvent("assistant_text", { messageId: "m1", text }) });
  });

  it("asks the session the picture came from, with the picture attached", async () => {
    const { api } = await openAndAsk();
    expect(api.sent[0]).toEqual({ id: "lead", text: "Make the sky warmer", attachments: [{ path: "/work/hero.png", mime: "image/png" }] });
    // And says so before anything is typed: where the question goes is what the send means.
    expect(within(viewerEl()!).getByRole("button", { name: "Logo rework" })).toBeInTheDocument();
  });

  it("draws the answer above the prompter, and only this viewer's part of the session", async () => {
    // THE MUTANT: render the whole transcript. A session of forty turns would bury the one answer.
    const { store } = await openAndAsk({ sessionEvents: { lead: [
      { seq: 1, sessionId: "lead", event: sessionEvent("user_message", { text: "An earlier question", attachments: [] }) },
      { seq: 2, sessionId: "lead", event: sessionEvent("assistant_text", { messageId: "m0", text: "An earlier answer" }) },
    ] } });
    answer(store, "Warmer it is.", 3);
    const thread = await waitFor(() => { const t = viewerEl()!.querySelector(".media-viewer-thread"); expect(t).not.toBeNull(); return t!; });
    await waitFor(() => expect(thread.textContent).toContain("Warmer it is."));
    expect(thread.textContent).not.toContain("An earlier answer");
  });

  it("puts a new version the answer names on the stage, with the original one step back", async () => {
    const { store } = await openAndAsk({}, [media("/work/hero.png"), media("/work/hero-warm.png")]);
    answer(store, "Saved the warmer one as `hero-warm.png`.");
    expect(await screen.findByRole("dialog", { name: "hero-warm.png" })).toBeInTheDocument();
    expect(within(viewerEl()!).getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(within(viewerEl()!).getByRole("button", { name: "Previous file" }));
    expect(await screen.findByRole("dialog", { name: "hero.png" })).toBeInTheDocument();
  });

  it("re-reads the picture when a turn ends having rewritten it in place", async () => {
    // THE MUTANT: stat once at open. The agent overwrites hero.png and the stage keeps the old one.
    const { store, realm } = await openAndAsk();
    await waitFor(() => expect(stageImg()?.getAttribute("src")).toMatch(/\?v=1$/));
    realm.files.stat.mockImplementation(async (path: string) => ({ path, size: 4096, mtimeMs: 2 }));
    act(() => store.getState().applySessionStatus("lead", "running"));
    act(() => store.getState().applySessionStatus("lead", "idle"));
    await waitFor(() => expect(stageImg()?.getAttribute("src")).toMatch(/\?v=2$/));
  });

  it("takes a file dropped anywhere on it into the next question, beside the one on show", async () => {
    // A reference picture, the palette to match. THE MUTANT: leave the handlers off the viewer — the
    // compact prompter takes no drag of its own, so a drop would fall through to the window and vanish.
    bridge([media("/work/hero.png")]);
    const { store } = await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    const dialog = await screen.findByRole("dialog", { name: "hero.png" });
    const file = Object.assign(new File([new Uint8Array(4)], "palette.png", { type: "image/png" }), { path: "/ref/palette.png" }) as unknown as File;
    const drag = { dataTransfer: { files: [file], items: [{ kind: "file" }], types: ["Files"] } };
    fireEvent.dragEnter(dialog, drag);
    expect(dialog.querySelector(".media-viewer-drop")).not.toBeNull();
    fireEvent.drop(dialog, drag);
    await waitFor(() => expect(store.getState().pendingAttachments[VIEWER_SLOT]?.map((a) => a.path)).toEqual(["/ref/palette.png"]));
    // The prompter shows both: the file on show, and the one that will go beside it.
    expect(within(dialog).getAllByRole("button", { name: /^Open (hero|palette)\.png$/ })).toHaveLength(2);
  });

  it("says when there is no session to ask, and which space the first question starts one in", async () => {
    bridge([media("/x/orphan.png")]);
    const { store } = await mount([]);
    act(() => store.getState().openViewer({ files: [{ path: "/x/orphan.png",
      from: { sessionId: "deleted", spaceId: "s2", sessionTitle: "Gone", kind: "output" } }] }));
    const dialog = await screen.findByRole("dialog", { name: "orphan.png" });
    expect(within(dialog).getByText("New session in Homework")).toBeInTheDocument();
    expect(within(dialog).getByText(/that session is gone/)).toBeInTheDocument();
  });
});

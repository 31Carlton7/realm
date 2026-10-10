import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mediaUrl, sessionEvent, type AgentKind, type MediaFile } from "@realm/contracts";
import { MediaStrip } from "../../panes/session/media/MediaView";
import { resetMediaCache } from "../../panes/session/media/use-media";
import { StoreContext, createAppStore, type AgentProbe } from "../../state/store";
import { claudeFolder, claudeRow, fakeApi, item, session, space, type FakeApi, type FakeData } from "../../state/store.test-fakes";
import { MediaViewer } from "./MediaViewer";
import { composeMarks } from "./markup";
import { MediaSessionContext } from "./open";
import { VIEWER_SLOT } from "../../state/viewer";
import { fitScale, stepZoom, anchoredScroll } from "./zoom";

// jsdom has no canvas to draw marks into, so the copy is made by a stand-in that says what it was given
// — a pasted file, with no path, which is the shape a drawn picture reaches the prompter in.
vi.mock("./markup", async (actual) => ({
  ...(await actual<typeof import("./markup")>()),
  composeMarks: vi.fn(async () => Object.assign(new File([new Uint8Array(4)], "hero-marked.png", { type: "image/png" }),
    { arrayBuffer: async () => new ArrayBuffer(4) })),
}));

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

  it("closes on ⌘W, the frontmost thing over the whole window, rather than a pane under it", async () => {
    bridge([media("/work/hero.png")]);
    const { api } = await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog", { name: "hero.png" });
    fireEvent.keyDown(prompter(), { key: "w", metaKey: true });
    await waitFor(() => expect(viewerEl()).toBeNull());
    expect(api.calls.some((c) => c.startsWith("closeItem") || c.startsWith("deleteItem"))).toBe(false);
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

  it("gives way to a surface opened over the window while it is up, which would otherwise open under it", async () => {
    // ⌘K over the viewer would put the palette — and the keyboard — behind a full-window overlay.
    // THE MUTANT: leave the viewer up; the palette opens where nobody can see it.
    bridge([media("/work/hero.png")]);
    const { store } = await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog", { name: "hero.png" });
    act(() => store.setState({ paletteOpen: true }));
    await waitFor(() => expect(store.getState().viewer).toBeNull());
  });

  it("opens over a page that is already up, and stays", async () => {
    // The Library is a page; a tile on it opens the viewer over it, and that page is not a newer one.
    bridge([media("/work/hero.png")]);
    const { store } = await mount([media("/work/hero.png")]);
    act(() => store.setState({ pageOverlay: { kind: "library-page", refId: "library", spaceId: "s1" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await screen.findByRole("dialog", { name: "hero.png" });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().viewer).not.toBeNull();
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

  it("holds the card's level and speed for the session a first question starts, with none to ask", async () => {
    // The card is drawn for the session the send will make, so it answers for that session too.
    // THE MUTANT: drop its presses while there is no session, as this prompter once did.
    bridge([media("/x/orphan.png")]);
    const { store, api } = await mount([]);
    act(() => store.getState().openViewer({ files: [{ path: "/x/orphan.png",
      from: { sessionId: "deleted", spaceId: "s2", sessionTitle: "Gone", kind: "output" } }] }));
    const dialog = await screen.findByRole("dialog", { name: "orphan.png" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
    fireEvent.keyDown(await screen.findByRole("slider", { name: "Effort" }), { key: "End" });
    await waitFor(() => expect(screen.getByRole("slider", { name: "Effort" })).toHaveAttribute("aria-valuetext", "Max"));
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fast mode" })).toHaveAttribute("aria-pressed", "true"));
    // The picker is a dialog of its own, still open: the viewer's box is found inside the viewer.
    const box = within(dialog).getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "What is this?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(store.getState().sessions[api.sent[0]!.id]).toMatchObject({ effort: "max", fastMode: true });
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

describe("marking up a picture", () => {
  /** jsdom implements no PointerEvent; a MouseEvent under its name carries the fields React reads. */
  const pointer = (target: Element, type: string, x: number, y: number) =>
    fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
  async function openMarkable() {
    const realm = bridge([media("/work/hero.png")]);
    const m = await mount([media("/work/hero.png")]);
    fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
    await waitFor(() => expect(stageImg()).not.toBeNull());
    loaded(stageImg()!);
    return { ...m, realm };
  }
  const frame = () => viewerEl()!.querySelector(".media-viewer-frame")!;
  const marksDrawn = () => viewerEl()!.querySelectorAll(".media-viewer-marks polyline").length;
  const draw = (from: [number, number], to: [number, number]) => {
    pointer(frame(), "pointerdown", ...from);
    pointer(frame(), "pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    pointer(frame(), "pointermove", ...to);
    pointer(frame(), "pointerup", ...to);
  };

  it("draws with the pen down, in the picture's own pixels, and takes the last mark back", async () => {
    const { store } = await openMarkable();
    const zoom = within(screen.getByRole("group", { name: "Zoom" }));
    fireEvent.click(zoom.getByRole("button", { name: "Mark up" }));
    expect(zoom.getByRole("button", { name: "Mark up" })).toHaveAttribute("aria-pressed", "true");
    draw([10, 10], [60, 40]);
    expect(marksDrawn()).toBe(1);
    // Fit is 100% in a box jsdom never lays out, so the picture's pixels are the screen's here.
    expect(store.getState().viewer!.marking!.marks[0]!.points.at(-1)).toEqual([60, 40]);
    // THE MUTANT: no pen — a drag is a pan, and nothing is drawn.
    fireEvent.click(zoom.getByRole("button", { name: "Undo the last mark" }));
    expect(marksDrawn()).toBe(0);
  });

  it("puts the pen away without putting the marks away, and draws nothing while it is away", async () => {
    await openMarkable();
    const zoom = within(screen.getByRole("group", { name: "Zoom" }));
    fireEvent.click(zoom.getByRole("button", { name: "Mark up" }));
    draw([10, 10], [60, 40]);
    fireEvent.click(zoom.getByRole("button", { name: "Mark up" }));
    expect(zoom.getByRole("button", { name: "Mark up" })).toHaveAttribute("aria-pressed", "false");
    draw([70, 70], [90, 90]);
    expect(marksDrawn()).toBe(1);
  });

  it("sends a copy with the marks on it beside the file, says so first, and then puts the marks away", async () => {
    const { api } = await openMarkable();
    fireEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Mark up" }));
    draw([10, 10], [60, 40]);
    expect(within(viewerEl()!).getByText("· with your marks, as hero-marked.png")).toBeInTheDocument();
    fireEvent.change(prompter(), { target: { value: "Brighten what I circled" } });
    fireEvent.keyDown(prompter(), { key: "Enter" });
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(vi.mocked(composeMarks)).toHaveBeenCalledWith("/work/hero.png", { w: 400, h: 300 }, [expect.objectContaining({ points: expect.any(Array) })]);
    expect(api.sent[0]!.attachments.map((a) => a.path)).toEqual(["/work/hero.png", "/realm-home/tmp/attachments/aa-hero-marked.png"]);
    await waitFor(() => expect(marksDrawn()).toBe(0));
  });

  it("keeps the words, and sends nothing, when the copy cannot be made", async () => {
    // A question about "the part I circled" without the circle is not the question that was asked.
    const { api, store } = await openMarkable();
    vi.mocked(composeMarks).mockResolvedValueOnce(null);
    fireEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Mark up" }));
    draw([10, 10], [60, 40]);
    fireEvent.change(prompter(), { target: { value: "Brighten what I circled" } });
    fireEvent.keyDown(prompter(), { key: "Enter" });
    await waitFor(() => expect(store.getState().toasts.at(-1)?.text).toMatch(/could not be drawn/));
    expect(api.sent).toHaveLength(0);
    expect(prompter().value).toBe("Brighten what I circled");
    expect(marksDrawn()).toBe(1);
  });

  it("takes Escape out of the pen first, keeping the marks, and out of the viewer only after", async () => {
    // THE MUTANT: close on the first Escape — a key pressed to stop drawing throws the drawing away.
    await openMarkable();
    const zoom = within(screen.getByRole("group", { name: "Zoom" }));
    fireEvent.click(zoom.getByRole("button", { name: "Mark up" }));
    draw([10, 10], [60, 40]);
    fireEvent.keyDown(prompter(), { key: "Escape" });
    expect(viewerEl()).not.toBeNull();
    expect(zoom.getByRole("button", { name: "Mark up" })).toHaveAttribute("aria-pressed", "false");
    expect(marksDrawn()).toBe(1);
    fireEvent.keyDown(prompter(), { key: "Escape" });
    await waitFor(() => expect(viewerEl()).toBeNull());
  });

  it("does not close on a stray click beside a picture that has marks on it", async () => {
    await openMarkable();
    fireEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Mark up" }));
    draw([10, 10], [60, 40]);
    fireEvent.click(viewerEl()!.querySelector(".media-viewer-canvas")!);
    expect(viewerEl()).not.toBeNull();
  });
});

/** Claude under a config folder a profile names, with nobody signed in, as the server answers it. */
const SIGNED_OUT_THERE: AgentProbe = { kind: "claude", available: true, version: "2.1.296", loggedIn: false, reason: null, home: "/Users/carlton/.claude-work" };

/** The viewer opened on a picture out of `lead`, here a session of `agentKind`, with the prompter
 *  docked under it. */
async function openFrom(agentKind: AgentKind, over: FakeData = {}) {
  bridge([media("/work/hero.png")]);
  const m = await mount([media("/work/hero.png")], { sessions: [session("lead", "s1", { title: "Logo rework", cwd: "/work", agentKind })], ...over });
  fireEvent.click(await screen.findByRole("button", { name: "Open hero.png larger" }));
  await screen.findByRole("dialog", { name: "hero.png" });
  return m;
}

/** The asks the fake logged for sessions' own Claude rows, in the order they were made. */
const sessionAsks = (api: FakeApi): string[] => api.calls.filter((c) => c.includes(":session:"));

describe("the viewer's prompter and its session's own Claude row", () => {
  it("asks for the row of the session the file came from, unforced, as it comes up", async () => {
    const { api } = await openFrom("claude");
    expect(sessionAsks(api)).toEqual(["probeAgent:claude:plain:session:lead"]);
  });

  it("asks for no Claude row on behalf of a Codex session", async () => {
    const { api } = await openFrom("codex");
    expect(sessionAsks(api)).toEqual([]);
  });

  it("asks for the next session's row when the file on show came from another session", async () => {
    bridge([media("/work/a.png"), media("/work/b.png")]);
    const { api, store } = await mount([], { sessions: [session("lead", "s1", { cwd: "/work", agentKind: "claude" }), session("other", "s1", { cwd: "/work", agentKind: "claude" })] });
    act(() => store.getState().openViewer({ files: [
      { path: "/work/a.png", from: { sessionId: "lead", spaceId: "s1", sessionTitle: "Logo rework", kind: "output" } },
      { path: "/work/b.png", from: { sessionId: "other", spaceId: "s1", sessionTitle: "Another look", kind: "output" } },
    ] }));
    await screen.findByRole("dialog", { name: "a.png" });
    fireEvent.keyDown(prompter(), { key: "ArrowRight" });
    await screen.findByRole("dialog", { name: "b.png" });
    expect(sessionAsks(api)).toEqual(["probeAgent:claude:plain:session:lead", "probeAgent:claude:plain:session:other"]);
  });

  it("reads Claude's sign-in off that session's own row, not off the window's list", async () => {
    const { store } = await openFrom("claude", { agentProbe: [claudeRow("me@example.com")], sessionClaude: { lead: SIGNED_OUT_THERE } });
    await act(async () => { await store.getState().probeAgents(); });
    fireEvent.click(within(viewerEl()!).getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).toHaveTextContent("signed out"));
  });

  it("keeps reading the window's list while no session is behind it", async () => {
    bridge([media("/x/orphan.png")]);
    const { store } = await mount([], { agentProbe: [{ ...SIGNED_OUT_THERE, home: null }] });
    await act(async () => { await store.getState().probeAgents(); });
    act(() => store.getState().openViewer({ files: [{ path: "/x/orphan.png" }] }));
    const dialog = await screen.findByRole("dialog", { name: "orphan.png" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).toHaveTextContent("signed out"));
  });

  it("asks for the row once the session the file came from is switched from Codex to Claude", async () => {
    const { api, store } = await openFrom("codex");
    expect(sessionAsks(api)).toEqual([]);
    await act(async () => { await store.getState().setSessionAgent("lead", "claude"); });
    await waitFor(() => expect(sessionAsks(api)).toEqual(["probeAgent:claude:plain:session:lead"]));
  });
});

/** The viewer over a file whose session is gone, which came from a space of School (p2), in a
 *  window that shows Work (p1). The window's list says the default folder is signed out. With
 *  `claudeDirs`, School names a folder of its own; without, no folder is in use anywhere. */
async function openFromSchool(claudeDirs: FakeData["claudeDirs"] = {}) {
  bridge([media("/x/orphan.png")]);
  const m = await mount([], {
    spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Thesis")],
    agentProbe: [{ ...SIGNED_OUT_THERE, home: null }], claudeDirs,
  });
  await act(async () => { await m.store.getState().probeAgents(); });
  await waitFor(() => expect(Object.keys(m.store.getState().claudeDirs).sort()).toEqual(["p1", "p2"]));
  act(() => m.store.getState().openViewer({ files: [{ path: "/x/orphan.png", from: { sessionId: "deleted", spaceId: "s9", sessionTitle: "Gone", kind: "output" } }] }));
  const dialog = await screen.findByRole("dialog", { name: "orphan.png" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
  return { ...m, dialog, claude: await screen.findByRole("option", { name: /Claude Fable 5\.1/ }) };
}

describe("the viewer's prompter before its first question, over a file from another profile's space", () => {
  it("says nothing of Claude's sign-in where a folder is in use, since the question would run under that profile's folder", async () => {
    const { dialog, claude } = await openFromSchool({ p2: claudeFolder("/Users/carlton/.claude-school") });
    expect(within(dialog).getByText("New session in Thesis")).toBeInTheDocument();
    expect(claude).not.toHaveTextContent("signed out");
  });

  it("goes on reading the window's list while no folder is in use, as it always did", async () => {
    const { claude } = await openFromSchool();
    await waitFor(() => expect(claude).toHaveTextContent("signed out"));
  });
});

/** The viewer over a file from `there`, a Claude session of School (p2) that holds a conversation,
 *  in a window that shows Work (p1). The window knows that session by the space it is in and holds
 *  no row of it: the row comes with the session's transcript, which is held back for the whole
 *  look. The window's list says the default folder is signed out, unless `rows.list` says what it
 *  reads. With `claudeDirs`, School names a folder of its own, which is signed in; without, no
 *  folder is in use anywhere. `rows.own` is what the server answers for that session's own row. */
async function openFromSchoolSession(claudeDirs: FakeData["claudeDirs"] = {}, rows: { list?: AgentProbe; own?: AgentProbe } = {}) {
  bridge([media("/x/notes.png")]);
  const school = claudeDirs.p2?.dir;
  const m = await mount([], {
    spaces: [space("s1", "p1", "Versed"), space("s9", "p2", "Thesis")],
    sessions: [session("lead", "s1", { title: "Logo rework", cwd: "/work" }), session("there", "s9", { title: "Thesis notes", agentKind: "claude", providerSessionId: "conversation-9" })],
    agentProbe: [rows.list ?? { ...SIGNED_OUT_THERE, home: null }], claudeDirs,
    profileClaude: school ? { p2: claudeRow("school@example.com", school) } : {},
    sessionClaude: rows.own ? { there: rows.own } : {},
  });
  const answering = m.api.sessionEvents;
  m.api.sessionEvents = (id, after, limit) => (id === "there" ? new Promise<never>(() => {}) : answering(id, after, limit));
  await act(async () => { await m.store.getState().probeAgents(); });
  await waitFor(() => expect(Object.keys(m.store.getState().claudeDirs).sort()).toEqual(["p1", "p2"]));
  act(() => m.store.getState().openViewer({ files: [{ path: "/x/notes.png", from: { sessionId: "there", spaceId: "s9", sessionTitle: "Thesis notes", kind: "output" } }] }));
  const dialog = await screen.findByRole("dialog", { name: "notes.png" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Model" }));
  return { ...m, dialog, claude: await screen.findByRole("option", { name: /Claude Fable 5\.1/ }) };
}

describe("the viewer's prompter over a file from a session the window knows only by its space", () => {
  it("says nothing of Claude's sign-in off the window's list where a folder is in use, since the question runs under the folder that session's conversation is in", async () => {
    const { store, claude } = await openFromSchoolSession({ p2: claudeFolder("/Users/carlton/.claude-school") });
    expect(store.getState().sessions.there).toBeUndefined();
    expect(claude).not.toHaveTextContent("signed out");
  });

  it("asks for that session's own row, though the window holds no row of the session to read its agent off", async () => {
    const { api } = await openFromSchoolSession({ p2: claudeFolder("/Users/carlton/.claude-school") });
    expect(sessionAsks(api)).toEqual(["probeAgent:claude:plain:session:there"]);
  });

  it("reads Claude's sign-in off that session's own row once the row has landed, and not off the window's list", async () => {
    const school = "/Users/carlton/.claude-school";
    await openFromSchoolSession({ p2: claudeFolder(school) }, { list: claudeRow("me@example.com"), own: { ...SIGNED_OUT_THERE, home: school } });
    await waitFor(() => expect(screen.getByRole("option", { name: /Claude Fable 5\.1/ })).toHaveTextContent("signed out"));
  });

  it("goes on reading the window's list for that session while no folder is in use, as it always did", async () => {
    const { claude } = await openFromSchoolSession({}, { own: claudeRow("school@example.com") });
    expect(claude).toHaveTextContent("signed out");
  });
});


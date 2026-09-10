import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent, type MediaFile } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { AttachmentTile } from "./AttachmentTile";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";
import { resetMediaCache } from "./media/use-media";

/** What main would answer for a real file on disk. */
const mediaFile = (path: string): MediaFile => ({ path, kind: "image", mime: "image/png", size: 4096 });

/**
 * Stand in for the preload bridge. `known` is the whole filesystem as far as the renderer is
 * concerned — anything else stats to null, which is how a file that has moved degrades.
 *
 * A tile that reaches for `openAttachment` has decided the file is not one the app can draw, so
 * which of the two the click lands on is the whole question here.
 */
function stubBridge(known: MediaFile[] = []) {
  const stat = vi.fn(async (candidates: readonly string[]) =>
    candidates.map((c) => known.find((f) => f.path === c) ?? null));
  const openAttachment = vi.fn(async () => {});
  vi.stubGlobal("realm", {
    openAttachment,
    attachmentThumbnail: vi.fn(async () => null),
    media: { stat, poster: vi.fn(async () => null), reveal: vi.fn(async () => {}), open: vi.fn(async () => {}) },
  });
  return { stat, openAttachment };
}

beforeEach(() => { resetMediaCache(); });
afterEach(() => { vi.unstubAllGlobals(); });

const lightbox = () => document.querySelector(".media-lightbox");

/** The path data a given glyph actually draws. `Icon` gives non-brand marks no name in the DOM, so
 *  the only honest way to assert WHICH glyph is on screen is to render the expected one and compare
 *  what it draws — which also catches a rename of the icon that a name string would not. */
function glyphPaths(node: Element | null): string {
  return [...(node?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d")).join("|");
}
function referenceGlyph(name: string): string {
  const { container, unmount } = render(<Icon name={name} size={18} />);
  const d = glyphPaths(container.querySelector("svg"));
  unmount();
  return d;
}

describe("a folder attached to a session", () => {
  it("wears a folder glyph, not a document one", async () => {
    // The report: dragging a folder in showed the same generic file glyph as any unrecognised
    // document. Only a `stat` can tell the two apart, so the answer rides the mime from main.
    stubBridge();
    const folder = referenceGlyph("folder"), artifact = referenceGlyph("artifact");
    expect(folder).not.toBe(artifact); // the test would prove nothing if these matched
    const { container } = render(<AttachmentTile path="/x/Notes" mime="inode/directory" />);
    expect(glyphPaths(container.querySelector(".attach-glyph"))).toBe(folder);
  });

  it("is a folder even when its name says it is a picture", async () => {
    // THE mutant: read the glyph off the path's extension instead of the mime. `photos.png` is a
    // real thing to call a folder, and it would be drawn as an image that cannot load.
    stubBridge();
    const { container } = render(<AttachmentTile path="/x/photos.png" mime="inode/directory" />);
    expect(glyphPaths(container.querySelector(".attach-glyph"))).toBe(referenceGlyph("folder"));
    expect(container.querySelector(".attach-ext")).toBeNull(); // and no "png" badge on a folder
  });

  it("does not offer to open one — on macOS an .app is a directory", async () => {
    // A tile that opened folders would launch a dragged-in Calculator.app on a click. The mime
    // table gate exists for exactly that, and a folder must not route around it.
    stubBridge();
    render(<AttachmentTile path="/x/Notes" mime="inode/directory" />);
    expect(screen.queryByRole("button", { name: "Open Notes" })).toBeNull();
  });

  it("never asks main for a thumbnail of a directory", async () => {
    const bridge = stubBridge();
    render(<AttachmentTile path="/x/Notes" mime="inode/directory" />);
    await waitFor(() => expect(document.querySelector(".attach-glyph")).not.toBeNull());
    expect((globalThis as unknown as { realm: { attachmentThumbnail: ReturnType<typeof vi.fn> } }).realm.attachmentThumbnail)
      .not.toHaveBeenCalled();
    expect(bridge.stat).not.toHaveBeenCalled();
  });
});

describe("opening an attachment from its tile", () => {
  it("hands a file the app cannot draw to the OS, and never to the lightbox", async () => {
    const { openAttachment } = stubBridge();
    render(<AttachmentTile path="/x/report.pdf" mime="application/pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));
    await waitFor(() => expect(openAttachment).toHaveBeenCalledWith("/x/report.pdf"));
    // The named mutant: route everything through MediaLightbox. A PDF has no MediaFile, so the
    // viewer would open on nothing — the broken-image-for-half-of-them failure.
    expect(lightbox()).toBeNull();
  });

  it("a PDF is never even put to media:stat — the scheme could not serve one", async () => {
    const { stat, openAttachment } = stubBridge();
    render(<AttachmentTile path="/x/report.pdf" mime="application/pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));
    await waitFor(() => expect(openAttachment).toHaveBeenCalled());
    expect(stat).not.toHaveBeenCalled();
  });

  it("opens media in the lightbox instead, and does not disturb the OS", async () => {
    const { openAttachment } = stubBridge([mediaFile("/x/shot.png")]);
    render(<AttachmentTile path="/x/shot.png" mime="image/png" />);
    const tile = screen.getByRole("button", { name: "Open shot.png" });
    await waitFor(() => expect(document.querySelector(".attach-tile[data-media]")).not.toBeNull());
    fireEvent.click(tile);
    await waitFor(() => expect(lightbox()).not.toBeNull());
    expect(openAttachment).not.toHaveBeenCalled();
  });

  it("an image whose file has since moved falls to the OS rather than an empty viewer", async () => {
    // Playable by extension, but main answers null: the branch is on what main SAID, not on the mime
    // the caller passed. Mutant — branch on `isPlayablePath(path)` — opens a lightbox on nothing.
    const { openAttachment, stat } = stubBridge([]);
    render(<AttachmentTile path="/x/gone.png" mime="image/png" />);
    await waitFor(() => expect(stat).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Open gone.png" }));
    await waitFor(() => expect(openAttachment).toHaveBeenCalledWith("/x/gone.png"));
    expect(lightbox()).toBeNull();
  });

  it("offers no open at all for an extension Realm cannot hand to anything", () => {
    // Main refuses an unknown extension (`open` RUNS an .app rather than showing it), so a tile that
    // still invited the click would be a dead control. Mutant: `canOpen = true`.
    stubBridge();
    render(<AttachmentTile path="/x/blob.weirdext" mime="application/octet-stream" />);
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(document.querySelector(".attach-tile")).not.toBeNull();
  });

  it("Escape closes the lightbox and puts focus back on the tile it came out of", async () => {
    stubBridge([mediaFile("/x/shot.png")]);
    render(<AttachmentTile path="/x/shot.png" mime="image/png" />);
    const tile = screen.getByRole("button", { name: "Open shot.png" });
    await waitFor(() => expect(document.querySelector(".attach-tile[data-media]")).not.toBeNull());
    fireEvent.click(tile);
    await waitFor(() => expect(lightbox()).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(lightbox()).toBeNull());
    // The named mutant: drop `opener.current?.focus()` in `close`. The keyboard would land back at
    // the top of the document, nowhere near the file just looked at.
    expect(document.activeElement).toBe(tile);
  });

  it("the tile is reached and opened by the keyboard alone", async () => {
    const { openAttachment } = stubBridge();
    render(<AttachmentTile path="/x/notes.md" mime="text/markdown" />);
    const tile = screen.getByRole("button", { name: "Open notes.md" });
    tile.focus();
    expect(document.activeElement).toBe(tile);
    // A real <button>, so Enter and Space are the browser's to deliver; clicking is what they raise.
    fireEvent.click(tile);
    await waitFor(() => expect(openAttachment).toHaveBeenCalledWith("/x/notes.md"));
  });
});

describe("remove and open are separate controls", () => {
  it("removing a file does not also open it", async () => {
    const { openAttachment } = stubBridge();
    const onRemove = vi.fn();
    render(<AttachmentTile path="/x/report.pdf" mime="application/pdf" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    // The mutant this pins: put the open handler on `.attach-tile` (or nest remove inside the open
    // button) and the ✕ opens the file on its way out.
    expect(openAttachment).not.toHaveBeenCalled();
    expect(lightbox()).toBeNull();
  });

  it("neither button is a descendant of the other", () => {
    stubBridge();
    render(<AttachmentTile path="/x/report.pdf" mime="application/pdf" onRemove={() => {}} />);
    const open = screen.getByRole("button", { name: "Open report.pdf" });
    const remove = screen.getByRole("button", { name: "Remove report.pdf" });
    expect(open.contains(remove)).toBe(false);
    expect(remove.contains(open)).toBe(false);
  });
});

describe("a sent tile and a pending tile are the same tile", () => {
  /** The transcript's own attachment row, rendered the way a user message carries it. */
  const sent = (attachments: { path: string; mime: string }[]) => render(
    <Transcript transcript={reduceAll([sessionEvent("user_message", { text: "look", attachments })])}
      sessionStatus="idle" visible focused cwd={null} sends={0} mentionIds={[]} onDecide={() => {}} />,
  );

  it("a sent PDF opens exactly the way a pending one does — it used to do nothing at all", async () => {
    const { openAttachment } = stubBridge();
    sent([{ path: "/x/report.pdf", mime: "application/pdf" }]);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));
    await waitFor(() => expect(openAttachment).toHaveBeenCalledWith("/x/report.pdf"));
  });

  it("a sent image still opens in the lightbox", async () => {
    stubBridge([mediaFile("/x/shot.png")]);
    sent([{ path: "/x/shot.png", mime: "image/png" }]);
    await waitFor(() => expect(document.querySelector(".attach-tile[data-media]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open shot.png" }));
    await waitFor(() => expect(lightbox()).not.toBeNull());
  });

  it("the sent row names its files through the tile, with no wrapper of its own", () => {
    stubBridge();
    sent([{ path: "/x/report.pdf", mime: "application/pdf" }]);
    const open = screen.getByRole("button", { name: "Open report.pdf" });
    // The tile carries the control itself; a wrapper around it would be a button inside a button —
    // invalid markup, and one tab stop too many on every attachment in the transcript.
    expect(open.className).toBe("attach-open");
    expect(open.querySelector("button")).toBeNull();
  });
});

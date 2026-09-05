import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent, type MediaFile } from "@realm/contracts";
import { AttachmentTile } from "./AttachmentTile";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";
import { resetMediaCache } from "./media/use-media";

/** What main would answer for a real file on disk. */
const mediaFile = (path: string, kind: MediaFile["kind"] = "image"): MediaFile => ({
  path, kind, size: 4096,
  mime: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
});

/**
 * Stand in for the preload bridge. `known` is the whole filesystem as far as the renderer is
 * concerned — anything else stats to null, which is how a moved file degrades.
 *
 * `openAttachment` is the OTHER half of the surface under test: a tile that reaches for it has
 * decided the file is not something the app can draw.
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
    const { stat } = stubBridge();
    render(<AttachmentTile path="/x/report.pdf" mime="application/pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open report.pdf" })).toBeInTheDocument());
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
    expect(onRemove).toHaveBeenCalledTimes(1);
    // The mutant this pins: put the open handler on `.attach-tile` (or nest remove inside the open
    // button) and the ✕ opens the file on its way out.
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
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
    // The old shape wrapped the tile in a second button. Two nested buttons is one tab stop too many
    // and invalid markup besides; the tile carries the control itself now.
    expect(open.className).toBe("attach-open");
    expect(open.querySelector("button")).toBeNull();
  });
});

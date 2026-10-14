import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AttachmentTile } from "./AttachmentTile";
import { resetMediaCache } from "./media/use-media";

let thumbnail: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetMediaCache();
  thumbnail = vi.fn(async () => null);
  vi.stubGlobal("realm", { attachmentThumbnail: thumbnail, media: { stat: vi.fn(async (c: readonly string[]) => c.map(() => null)) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the prompter's attachment card", () => {
  it("names a file that is not a picture: its logo, its name, its kind and size", () => {
    const { container } = render(<AttachmentTile path="/w/src/server.ts" mime="text/plain" name="server.ts" size={4300} layout="card" onRemove={() => {}} />);
    const tile = container.querySelector(".attach-tile")!;
    expect(tile.getAttribute("data-layout")).toBe("card");
    expect(tile.querySelector(".attach-card-name")!.textContent).toBe("server.ts");
    expect(tile.querySelector(".attach-card-kind")!.textContent).toBe("TS · 4.2 KB");
    expect(tile.querySelector(".file-mark")!.getAttribute("data-mark")).toBe("typescript");
  });

  it("asks main for no picture of it — a page of source at 32px is a QuickLook process for nothing", () => {
    render(<AttachmentTile path="/w/report.pdf" mime="application/pdf" size={10} layout="card" />);
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it("draws a folder as a folder, said in words", () => {
    const { container } = render(<AttachmentTile path="/w/assets" mime="inode/directory" layout="card" />);
    const tile = container.querySelector(".attach-tile")!;
    expect(tile.hasAttribute("data-folder")).toBe(true);
    expect(tile.querySelector(".attach-card-kind")!.textContent).toBe("Folder");
    expect(tile.querySelector(".file-mark")!.getAttribute("data-mark")).toBe("folder");
  });

  it("keeps a picture the square it was, asking for its thumbnail", async () => {
    const { container } = render(<AttachmentTile path="/w/hero.png" mime="image/png" layout="card" />);
    expect(container.querySelector(".attach-tile")!.hasAttribute("data-layout")).toBe(false);
    expect(container.querySelector(".attach-art")).not.toBeNull();
    await vi.waitFor(() => expect(thumbnail.mock.calls.map((c) => c[0])).toContain("/w/hero.png"));
  });

  it("says File for a name with no extension", () => {
    const { container } = render(<AttachmentTile path="/w/Makefile" mime="text/plain" size={20} layout="card" />);
    expect(container.querySelector(".attach-card-kind")!.textContent).toBe("File · 20 B");
  });

  it("Remove takes this file out, and is not the open control", () => {
    const onRemove = vi.fn();
    const { getByRole } = render(<AttachmentTile path="/w/a.md" mime="text/markdown" name="a.md" size={1} layout="card" onRemove={onRemove} />);
    fireEvent.click(getByRole("button", { name: "Remove a.md" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("a square for a text file wears its mark and asks for no picture of its page", () => {
    const { container } = render(<AttachmentTile path="/w/notes.md" mime="text/markdown" />);
    expect(container.querySelector(".attach-art .file-mark")!.getAttribute("data-mark")).toBe("markdown");
    expect(thumbnail).not.toHaveBeenCalled();
  });

  it("is heard as its name and the tip's line, once", () => {
    const { container } = render(<AttachmentTile path="/w/a.ts" mime="text/plain" name="a.ts" size={1} layout="card" detail="1 B · Claude reads it" />);
    expect(container.querySelector(".attach-card-text")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".visually-hidden")!.textContent).toBe("a.ts — 1 B · Claude reads it");
  });

  it("the transcript's tile is still the square", () => {
    const { container } = render(<AttachmentTile path="/w/server.ts" mime="text/plain" />);
    expect(container.querySelector(".attach-tile")!.hasAttribute("data-layout")).toBe(false);
  });
});

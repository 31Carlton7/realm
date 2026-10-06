import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fileDragProps, quickLookOnSpace, shareFile } from "./file-actions";

afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });
const install = () => {
  const files = { quickLook: vi.fn(async () => {}), share: vi.fn(async () => {}), startDrag: vi.fn() };
  (window as { realm?: unknown }).realm = { files };
  return files;
};
function Tile({ path, onOpen }: { path: string; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} onKeyDown={quickLookOnSpace(path)} {...fileDragProps(path)}>file</button>;
}

describe("a file the page shows", () => {
  /* THE mutants: Space still pressing the button (opening the sheet instead of looking), and Enter
     being taken too — the Finder's split is Space looks, Return acts. */
  it("shows it in Quick Look on Space, and leaves Enter and modified keys to the button", () => {
    const files = install();
    const onOpen = vi.fn();
    render(<Tile path="/work/report.pdf" onOpen={onOpen} />);
    const tile = screen.getByRole("button");
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    tile.dispatchEvent(space);
    expect(files.quickLook).toHaveBeenCalledWith("/work/report.pdf");
    expect(space.defaultPrevented).toBe(true);
    fireEvent.keyDown(tile, { key: "Enter" });
    fireEvent.keyDown(tile, { key: " ", metaKey: true });
    fireEvent.keyDown(tile, { key: " ", repeat: true });
    expect(files.quickLook).toHaveBeenCalledTimes(1);
  });

  it("drags out through main, cancelling the page's own drag", () => {
    const files = install();
    render(<Tile path="/work/report.pdf" onOpen={() => {}} />);
    const tile = screen.getByRole("button");
    expect(tile).toHaveAttribute("draggable", "true");
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    tile.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    expect(files.startDrag).toHaveBeenCalledWith("/work/report.pdf");
  });

  /* Where there is no bridge there is no Quick Look panel and no OS drag: the tile is an ordinary
     button, not one that swallows Space or drags into nothing. */
  it("is an ordinary button where the desktop bridge is absent", () => {
    const onOpen = vi.fn();
    render(<Tile path="/work/report.pdf" onOpen={onOpen} />);
    const tile = screen.getByRole("button");
    expect(tile).not.toHaveAttribute("draggable");
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    tile.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
  });

  it("puts the Share menu under the element that asked", () => {
    const files = install();
    const el = document.createElement("button");
    el.getBoundingClientRect = () => ({ left: 30, bottom: 50, top: 20, right: 60, width: 30, height: 30, x: 30, y: 20, toJSON: () => ({}) });
    shareFile("/work/report.pdf", el);
    expect(files.share).toHaveBeenCalledWith("/work/report.pdf", { x: 30, y: 54 });
  });
});

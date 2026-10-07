import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "./Transcript";
import { forgetLookedFiles } from "./file-links";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

/** The files that exist, as main's `files.stat` would answer: a regular file, or null. */
const onDisk = new Set(["/w/app/web/lib/orgs.ts", "/w/app/web/lib/agent/chat-runtime/compaction/auto-compact.ts"]);
const stat = vi.fn(async (path: string) => (onDisk.has(path) ? { path, size: 1, mtimeMs: 0 } : null));

beforeEach(() => {
  forgetLookedFiles();
  stat.mockClear();
  (window as unknown as { realm: unknown }).realm = { files: { stat } };
});
afterEach(() => { cleanup(); delete (window as unknown as { realm?: unknown }).realm; });

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

const said = (text: string, streaming = false): Block[] => [
  { kind: "tool", toolUseId: "e1", name: "Edit", input: { file_path: "/w/app/web/lib/agent/chat-runtime/compaction/auto-compact.ts", old_string: "a", new_string: "b" }, result: { content: "ok", isError: false }, ts: 1 },
  { kind: "assistant", messageId: "m1", text, streaming, ts: 2 },
];

const PROSE = "The important change is in `web/lib/orgs.ts:83`, and I kept `auto-compact.ts` compatible. "
  + "Nothing in `web/lib/gone.ts` or /etc/hosts.txt was touched.";

describe("a file the agent names", () => {
  it("becomes a link that opens it at its line — only once the disk says it is a file in this checkout", async () => {
    const onOpen = vi.fn();
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onPath={() => {}} cwd="/w/app"
      checkout={{ root: "/w/app", onOpen }} transcript={model(said(PROSE))} />);
    await waitFor(() => expect(document.querySelectorAll(".md-file")).toHaveLength(2));
    const [orgs, compact] = [...document.querySelectorAll<HTMLElement>(".md-file")];
    expect(orgs!.textContent).toBe("web/lib/orgs.ts (line 83)");
    // The bare name resolved to the one file of that name this session edited.
    expect(compact!.getAttribute("data-file")).toBe("/w/app/web/lib/agent/chat-runtime/compaction/auto-compact.ts");
    // A path that is not there stays exactly what the agent wrote, and one outside the checkout is
    // never even asked about.
    expect([...document.querySelectorAll("code")].map((c) => c.textContent)).toContain("web/lib/gone.ts");
    expect(stat.mock.calls.map((c) => c[0])).not.toContain("/etc/hosts.txt");

    fireEvent.click(orgs!);
    expect(onOpen).toHaveBeenCalledWith("/w/app/web/lib/orgs.ts", 83);
    fireEvent.keyDown(compact!, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("/w/app/web/lib/agent/chat-runtime/compaction/auto-compact.ts", null);
  });

  it("is left as text while the message is still arriving", async () => {
    render(<Transcript sessionStatus="running" onDecide={() => {}} onPath={() => {}} cwd="/w/app"
      checkout={{ root: "/w/app", onOpen: () => {} }} transcript={model(said(PROSE, true))} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".md-file")).toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it("is never a link in a read-only mount that has no checkout to open it in", async () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} onPath={() => {}} cwd="/w/app" transcript={model(said(PROSE))} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".md-file")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { isEmptySummary, linksIn, mediaKindOf, summarize, writtenPath } from "./session-summary";
import type { Block } from "./transcript-model";

const ok = { content: "done", isError: false };
const tool = (name: string, input: Record<string, unknown>, ts: number, result: typeof ok | null = ok): Block =>
  ({ kind: "tool", toolUseId: `t${ts}:${name}`, name, input, result, ts });
const assistant = (text: string, ts: number, streaming = false): Block =>
  ({ kind: "assistant", messageId: `m${ts}`, text, streaming, ts });
const user = (text: string, ts: number, attachments?: { path: string; mime: string }[]): Block =>
  ({ kind: "user", text, ts, ...(attachments ? { attachments } : {}) });
const plan = (planId: string, ts: number, over: Partial<Block & { kind: "plan" }> = {}): Block =>
  ({ kind: "plan", planId, ts, ...over } as Block);

describe("writtenPath", () => {
  it("reads the path each write-shaped tool actually names", () => {
    expect(writtenPath("Write", { file_path: "/a/b.ts", content: "x" })).toBe("/a/b.ts");
    expect(writtenPath("NotebookEdit", { notebook_path: "/a/n.ipynb" })).toBe("/a/n.ipynb");
    expect(writtenPath("apply_patch", { changes: [{ path: "/a/c.rs" }, { path: "/a/d.rs" }] })).toBe("/a/c.rs");
  });
  it("has no answer when the payload names none, rather than inventing an empty path", () => {
    expect(writtenPath("Write", { content: "x" })).toBeNull();
    expect(writtenPath("Write", { file_path: "" })).toBeNull();
    expect(writtenPath("apply_patch", { changes: [] })).toBeNull();
  });
});

describe("linksIn", () => {
  it("finds bare and markdown links alike, and stops at sentence punctuation", () => {
    expect(linksIn("Deployed to https://app.test/x. Also [see](https://b.test/y), maybe."))
      .toEqual(["https://app.test/x", "https://b.test/y"]);
  });
  it("finds nothing in prose that names no url", () => {
    expect(linksIn("no links here, just a file at /tmp/a.txt")).toEqual([]);
  });
});

describe("mediaKindOf", () => {
  it("sorts a path by what opening it would mean", () => {
    expect(mediaKindOf("/a/shot.png")).toBe("image");
    expect(mediaKindOf("/a/clip.mov")).toBe("video");
    expect(mediaKindOf("/a/report.pdf")).toBe("file");
    expect(mediaKindOf("/a/Makefile")).toBe("file");
  });
});

describe("summarize", () => {
  it("lists a file a tool WROTE, and not one it merely read", () => {
    // The distinction is the whole value of the list: a session that read forty files to answer a
    // question produced nothing, and a "files touched" tally would just be the transcript again.
    const s = summarize([
      tool("Read", { file_path: "/a/read-only.ts" }, 1),
      tool("Grep", { pattern: "x", path: "/a" }, 2),
      tool("Write", { file_path: "/a/made.ts" }, 3),
    ]);
    expect(s.outputs.map((o) => o.kind === "file" && o.path)).toEqual(["/a/made.ts"]);
  });

  it("refuses a write that failed or has not come back", () => {
    const s = summarize([
      tool("Write", { file_path: "/a/failed.ts" }, 1, { content: "EACCES", isError: true }),
      tool("Edit", { file_path: "/a/pending.ts" }, 2, null),
    ]);
    expect(s.outputs).toEqual([]);
  });

  it("counts a file edited nine times once, and dates it by the LAST edit", () => {
    const s = summarize([
      tool("Write", { file_path: "/a/x.ts" }, 10),
      tool("Edit", { file_path: "/a/x.ts" }, 20),
      tool("Edit", { file_path: "/a/x.ts" }, 30),
    ]);
    expect(s.outputs).toHaveLength(1);
    expect(s.outputs[0]!.ts).toBe(30);
  });

  it("takes a link the agent OFFERED but not one it went and read", () => {
    // A fetched page is something the session consumed, and it already appears under the message
    // that read it. Listing it under "what this session made" would be the overreach the rule exists
    // to prevent — so the fetch is what disqualifies the url, not where in the prose it sits.
    const s = summarize([
      tool("WebFetch", { url: "https://docs.test/guide" }, 1),
      assistant("Read https://docs.test/guide and deployed to https://app.test/live", 2),
    ]);
    expect(s.outputs.map((o) => o.kind === "url" && o.url)).toEqual(["https://app.test/live"]);
  });

  it("waits for the full stop before reading a link out of a streaming message", () => {
    // Half a url is a different url, and a row that appeared, changed and vanished as the sentence
    // completed would be worse than one that waits.
    expect(summarize([assistant("shipped to https://app.te", 1, true)]).outputs).toEqual([]);
    expect(summarize([assistant("shipped to https://app.test/x", 1, false)]).outputs).toHaveLength(1);
  });

  it("ignores a link that is not a page anyone can open", () => {
    expect(summarize([assistant("see file:///etc/hosts and ftp://x.test/a", 1)]).outputs).toEqual([]);
  });

  it("collects what the USER uploaded, deduped by path", () => {
    const s = summarize([
      user("look", 1, [{ path: "/u/shot.png", mime: "image/png" }, { path: "/u/spec.pdf", mime: "application/pdf" }]),
      user("again", 2, [{ path: "/u/shot.png", mime: "image/png" }]),
      user("no files", 3),
    ]);
    expect(s.uploads.map((u) => u.name)).toEqual(["spec.pdf", "shot.png"]); // newest first, one shot.png
    expect(s.uploads.find((u) => u.name === "shot.png")!.ts).toBe(2);
  });

  it("keeps every plan the agent proposed, with its steps", () => {
    const s = summarize([
      plan("p1", 1, { text: "# First pass\n\nDo the thing." }),
      plan("p2", 2, { steps: [{ text: "one", status: "completed" }, { text: "two", status: "pending" }] }),
    ]);
    expect(s.plans.map((p) => p.planId)).toEqual(["p2", "p1"]);
    expect(s.plans[0]!.steps).toHaveLength(2);
    expect(s.plans[1]!.text).toContain("First pass");
  });

  it("reads a fully-prefixed MCP tool by its bare name", () => {
    // Nothing in the renderer normalises these, so a summary that matched the raw name would miss
    // every browser navigation and never disqualify the page it opened.
    const s = summarize([
      tool("mcp__realm__realm-browser__browser_open", { url: "https://x.test/a" }, 1),
      assistant("opened https://x.test/a", 2),
    ]);
    expect(s.outputs).toEqual([]);
  });

  it("is empty for a transcript that has produced, received and proposed nothing", () => {
    expect(isEmptySummary(summarize([user("hi", 1), assistant("hello", 2), tool("Read", { file_path: "/a" }, 3)]))).toBe(true);
    expect(isEmptySummary(summarize([tool("Write", { file_path: "/a/x" }, 1)]))).toBe(false);
  });

  it("orders every list newest-first — the question is what it just made", () => {
    const s = summarize([
      tool("Write", { file_path: "/a/old.ts" }, 1),
      tool("Write", { file_path: "/a/new.ts" }, 2),
    ]);
    expect(s.outputs.map((o) => o.kind === "file" && o.name)).toEqual(["new.ts", "old.ts"]);
  });
});

import { describe, expect, it } from "vitest";
import { sourcesFor, turnBlocks } from "./message-sources";
import type { Block } from "./transcript-model";

const user = (text: string): Block => ({ kind: "user", text, ts: 0 });
const say = (text: string, messageId = "m1"): Block => ({ kind: "assistant", messageId, text, streaming: false, ts: 0 });
const tool = (name: string, input: Record<string, unknown>, result: { content: string; isError: boolean } | null = { content: "ok", isError: false }): Block =>
  ({ kind: "tool", toolUseId: `t${name}${JSON.stringify(input)}`, name, input, result, ts: 0 });

const urls = (blocks: Block[]) => sourcesFor(blocks, blocks.length - 1).map((s) => s.url);

describe("what counts as a source", () => {
  it("takes the url a WebFetch was actually pointed at", () => {
    expect(urls([user("q"), tool("WebFetch", { url: "https://example.com/a", prompt: "read it" }), say("answer")]))
      .toEqual(["https://example.com/a"]);
  });

  it("takes the browser tools too, prefixed as MCP delivers them", () => {
    // Claude's SDK prefixes every MCP tool `mcp__<server>__<tool>`, and nothing in the renderer
    // normalises that — matched on the bare name or these never match at all.
    expect(urls([
      user("q"),
      tool("mcp__realm__realm-browser__browser_open", { url: "https://a.test/x" }),
      tool("mcp__realm__realm-browser__browser_navigate", { browserId: "b1", url: "https://b.test/y" }),
      say("answer"),
    ])).toEqual(["https://a.test/x", "https://b.test/y"]);
  });

  it("refuses a WebSearch: a query is not a page, and its results are links it was shown, not read", () => {
    // Refused by NAME, not by luck. The `url` is in the input here deliberately — the search shapes
    // differ across adapters and one carrying a url must still not count, because searching a page
    // is not reading it. Without the name check this passes only until an adapter changes.
    expect(urls([
      user("q"),
      tool("WebSearch", { query: "best kettle", url: "https://shop.test/kettle" },
        { content: "1. https://shop.test/kettle\n2. https://other.test/k", isError: false }),
      say("answer"),
    ])).toEqual([]);
  });

  it("refuses a url the model merely typed — nothing in here reads the message at all", () => {
    expect(urls([user("q"), say("You can read more at https://invented.test/page and [here](https://also.test/x).")]))
      .toEqual([]);
  });

  it("refuses a fetch that failed, and one that has not come back", () => {
    expect(urls([user("q"), tool("WebFetch", { url: "https://dead.test/a" }, { content: "404", isError: true }), say("a")])).toEqual([]);
    expect(urls([user("q"), tool("WebFetch", { url: "https://slow.test/a" }, null), say("a")])).toEqual([]);
  });

  it("refuses a url that is not a page anyone can be sent to", () => {
    expect(urls([user("q"), tool("WebFetch", { url: "file:///etc/passwd" }), say("a")])).toEqual([]);
    expect(urls([user("q"), tool("WebFetch", { url: "not a url" }), say("a")])).toEqual([]);
    expect(urls([user("q"), tool("WebFetch", { url: 42 }), say("a")])).toEqual([]);
  });

  it("credits each answer with its own turn's fetches, never the previous turn's", () => {
    const blocks: Block[] = [
      user("first"), tool("WebFetch", { url: "https://one.test/a" }), say("one", "m1"),
      user("second"), tool("WebFetch", { url: "https://two.test/b" }), say("two", "m2"),
    ];
    expect(sourcesFor(blocks, 2).map((s) => s.url)).toEqual(["https://one.test/a"]);
    expect(sourcesFor(blocks, 5).map((s) => s.url)).toEqual(["https://two.test/b"]);
  });

  it("lists one page once, however many times it was fetched", () => {
    expect(urls([
      user("q"),
      tool("WebFetch", { url: "https://example.com/a" }),
      tool("mcp__realm__realm-browser__browser_open", { url: "https://example.com/a" }),
      say("answer"),
    ])).toEqual(["https://example.com/a"]);
  });

  it("splits a url into the part that says WHO and the part that says which page", () => {
    const [s] = sourcesFor([user("q"), tool("WebFetch", { url: "https://www.example.com/docs/a?v=2" }), say("a")], 2);
    expect(s).toEqual({ url: "https://www.example.com/docs/a?v=2", host: "example.com", path: "/docs/a?v=2" });
  });

  it("scopes a turn to the user message that opened it", () => {
    const blocks: Block[] = [user("a"), say("one"), user("b"), tool("WebFetch", { url: "https://x.test/" }), say("two", "m2")];
    expect(turnBlocks(blocks, 4).map((b) => b.kind)).toEqual(["tool"]);
    expect(turnBlocks(blocks, 1).map((b) => b.kind)).toEqual([]);
  });
});

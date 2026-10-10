import { describe, expect, it } from "vitest";
import { actKindFor } from "./team-acts";
import {
  bodyHead, inferFormat, isLinkList, itemActKind, itemTarget, itemVerb, lineDiff, reviewCardKind, reviewVerb, type DeliverableItem,
} from "./team-deliverables";

const item = (o: Partial<DeliverableItem>): DeliverableItem => ({ files: [], body: null, ...o });

describe("inferFormat", () => {
  it.each<[string, Partial<DeliverableItem>, string]>([
    ["every file a picture", { files: ["deck/01.png", "deck/02.JPG"] }, "images"],
    ["a PDF", { files: ["brief.pdf"], body: "the brief" }, "pdf"],
    ["a .md file", { files: ["notes/answer.md"] }, "markdown"],
    ["a patch", { files: ["fix.patch"] }, "diff"],
    ["a CSV", { files: ["leads.csv"] }, "table"],
    ["a .links.md file", { files: ["reading.links.md"] }, "links"],
    ["anything else", { files: ["clip.mov", "deck/01.png"] }, "files"],
    ["a send with no files", { body: "Hi Dana", action: { connector: "mcp:gmail", verb: "send" } }, "email"],
    ["a Subject in meta", { body: "Hi", meta: { Subject: "Pilot" } }, "email"],
    ["a legacy email target with no account", { body: "Hi Nathan", target: { channel: "Email" } }, "email"],
    ["a DM's words", { body: "thanks!", action: { connector: "channel:instagram", verb: "dm", account: "@a", to: "@b" } }, "message"],
    ["a list of links", { body: "- [Paper](https://arxiv.org/abs/1)\n- https://example.com/x" }, "links"],
    ["a Markdown table", { body: "| a | b |\n|---|---|\n| 1 | 2 |" }, "table"],
    ["a diff body", { body: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b" }, "diff"],
    ["Markdown prose", { body: "# Answer\n\nIt is **yes**." }, "markdown"],
    ["plain words", { body: "It is yes." }, "text"],
  ])("%s → its format", (_, o, want) => {
    // THE MUTANT: any rule of the table dropped or reordered — its row lands in the wrong renderer.
    expect(inferFormat(item(o))).toBe(want);
  });

  it("keeps a format the item names over anything it would infer, and ignores one it does not know", () => {
    expect(inferFormat(item({ files: ["deck/01.png"], format: "files" }))).toBe("files");
    expect(inferFormat(item({ files: ["deck/01.png"], format: "hologram" }))).toBe("images");
  });

  it("reads a line list only when EVERY line is a link", () => {
    expect(isLinkList("https://a.com\nhttps://b.com")).toBe(true);
    expect(isLinkList("see https://a.com for more")).toBe(false);
  });
});

describe("a legacy item's act, by its action or its target", () => {
  const targets = [
    { channel: "TikTok", account: "@versed.nathan" },
    { channel: "Instagram", account: "@versed.nathan", to: "@reader" },
    { channel: "Email", account: "me@x.co", to: "nathan@y.co" },
    { channel: " mail ", account: "me@x.co", to: "n@y.co" },
    { account: "@versed.nathan" },
    { channel: "TikTok" },
  ];
  /** The v52 backfill's rule, as SQL writes it: only slideshows and messages, only with a channel and an account. */
  const backfill = (label: string, t: { channel?: string; account?: string; to?: string }) => {
    const ch = t.channel?.trim().toLowerCase();
    if (!ch || !t.account || (label !== "slideshows" && label !== "message")) return null;
    return { connector: `channel:${ch}`, verb: label === "slideshows" ? "post" : ch === "email" || ch === "mail" ? "email" : "dm", account: t.account, to: t.to ?? null, legacy: 1 };
  };
  it("is exactly actKindFor's answer, before the backfill and after it, for every label and target", () => {
    for (const label of ["slideshows", "message", "document", "report"]) {
      for (const target of targets) {
        const want = actKindFor(label, target.channel);
        const before = item({ target, body: "x" });
        const after = item({ target, body: "x", action: backfill(label, target) });
        // THE MUTANT: a missing channel read as a post, or a channel's case breaking the email rule.
        expect(itemActKind(label, before), `${label} ${JSON.stringify(target)}`).toBe(want);
        if (target.account) expect(itemActKind(label, after), `${label} ${JSON.stringify(target)} backfilled`).toBe(want);
      }
    }
  });

  it("keeps the target's channel as written, reads a new action's channel off its connector, and sends email on an email channel", () => {
    // THE MUTANT: `send` read as a DM whatever the channel, or the target's case lost to the connector's.
    expect(itemTarget(item({ target: { channel: "TikTok", account: "@a" }, action: { connector: "channel:tiktok", verb: "post", account: "@a" } }))).toEqual({ channel: "TikTok", account: "@a" });
    expect(itemTarget(item({ action: { connector: "channel:instagram", verb: "dm", account: "@a", to: "@b" } }))).toEqual({ channel: "instagram", account: "@a", to: "@b" });
    expect(itemActKind("posts", item({ action: { connector: "channel:tiktok", verb: "post", account: "@a" } }))).toBe("post");
    expect(itemActKind("replies", item({ action: { connector: "channel:email", verb: "send", account: "me@x.co", to: "d@y.co" } }))).toBe("email");
    expect(itemActKind("replies", item({ action: { connector: "channel:instagram", verb: "send", account: "@a", to: "@b" } }))).toBe("dm");
  });

  it("makes no channel act of a connector's tool — that is a later PR's executor", () => {
    expect(itemActKind("replies", item({ action: { connector: "mcp:gmail", tool: "send_message", verb: "send", account: "me@x.co", to: "d@y.co" } }))).toBeNull();
  });
});

describe("words from the verb, never from the label", () => {
  it("heads the text Caption for a post, Message for a send, Text otherwise", () => {
    expect(bodyHead("post")).toBe("Caption");
    expect(bodyHead("dm")).toBe("Message");
    expect(bodyHead("send")).toBe("Message");
    expect(bodyHead(null)).toBe("Text");
  });

  it("reads a review by its first item's verb, and the legacy labels by what they always meant", () => {
    expect(reviewVerb("message", [item({ body: "hi" })])).toBe("send");
    expect(reviewVerb("slideshows", [item({ files: ["a.png"] })])).toBe("post");
    expect(reviewVerb("research", [item({ body: "x" })])).toBeNull();
    expect(itemVerb("research", item({ action: { connector: "mcp:gmail", verb: "Send" } }))).toBe("send");
  });

  it("lines a card with the legacy words, a label as written, or the count and format when there is no label", () => {
    expect(reviewCardKind({ kind: "slideshows", itemCount: 6 })).toBe("6 slideshows");
    expect(reviewCardKind({ kind: "message", itemCount: 1 })).toBe("email draft");
    expect(reviewCardKind({ kind: "release notes", itemCount: 2, format: "diff" })).toBe("release notes");
    expect(reviewCardKind({ kind: "diff", itemCount: 2, format: "diff" })).toBe("2 items · diff");
  });
});

describe("lineDiff", () => {
  it("names the lines a person took out and put in, and nothing they left alone", () => {
    expect(lineDiff("Hi Dana,\nthanks for Monday.\nCarlton", "Hi Dana,\nthanks for the call on Monday.\nCarlton"))
      .toBe("-thanks for Monday.\n+thanks for the call on Monday.");
    expect(lineDiff("a", "a")).toBe("");
  });
});

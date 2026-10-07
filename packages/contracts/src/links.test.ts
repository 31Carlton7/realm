import { describe, expect, it } from "vitest";
import { describeLink } from "./links";
import { expandLinkChips, scanChips, scanLinkChips } from "./chips";

describe("describeLink", () => {
  it("names a Slack permalink by its thread, and a bare channel link by the channel", () => {
    expect(describeLink("https://acme.slack.com/archives/C0123ABC/p1712345678123456")).toMatchObject({ service: "slack", label: "Thread 1712345678.123456" });
    expect(describeLink("https://acme.slack.com/archives/C0123ABC")).toMatchObject({ service: "slack", label: "Channel C0123ABC" });
  });

  it("reads a Notion page's title out of its slug and drops the id", () => {
    expect(describeLink("https://www.notion.so/acme/Card-redesign-and-model-picker-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d")).toMatchObject({ service: "notion", label: "Card redesign and model picker" });
    expect(describeLink("https://acme.notion.site/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d")).toMatchObject({ service: "notion", label: "Notion page" });
  });

  it("names a Linear issue by its key, upper-cased", () => {
    expect(describeLink("https://linear.app/acme/issue/eng-123/fix-the-login-flow")).toMatchObject({ service: "linear", label: "ENG-123" });
    expect(describeLink("https://linear.app/acme/project/onboarding-v2-8f2a1c3d")).toMatchObject({ service: "linear", label: "onboarding v2" });
  });

  it("names GitHub pulls, issues, files and repos the way people say them", () => {
    expect(describeLink("https://github.com/acme/realm/pull/42")).toMatchObject({ service: "github", label: "acme/realm#42" });
    expect(describeLink("https://github.com/acme/realm/issues/7")).toMatchObject({ service: "github", label: "acme/realm#7" });
    expect(describeLink("https://github.com/acme/realm/blob/main/src/app.ts")).toMatchObject({ service: "github", label: "acme/realm · src/app.ts" });
    expect(describeLink("https://github.com/acme/realm")).toMatchObject({ service: "github", label: "acme/realm" });
  });

  it("names Jira issues, Figma files with their node, and Sentry issues", () => {
    expect(describeLink("https://acme.atlassian.net/browse/PROJ-9")).toMatchObject({ service: "jira", label: "PROJ-9" });
    expect(describeLink("https://www.figma.com/design/abc123/Realm-App?node-id=12-34")).toMatchObject({ service: "figma", label: "Realm App · 12:34" });
    expect(describeLink("https://acme.sentry.io/issues/123456789/")).toMatchObject({ service: "sentry", label: "Issue 123456789" });
  });

  it("reads Notion's app.notion.com copy-link form too", () => {
    expect(describeLink("https://app.notion.com/p/caikins/Meeting-3d5f2fa921c480e4b615ce56419c21f5?source=copy_link")).toMatchObject({ service: "notion", label: "Meeting" });
  });

  /* Both hosts, because half the X links in circulation still say twitter.com, and the author rather
     than the id, because nineteen digits is exactly what a chip exists to replace. */
  it("names an X post by its author and a profile by its handle, on either host", () => {
    expect(describeLink("https://x.com/paulg/status/1839291043128172544")).toMatchObject({ service: "x", label: "Post by @paulg" });
    expect(describeLink("https://twitter.com/paulg/status/1839291043128172544")).toMatchObject({ service: "x", label: "Post by @paulg" });
    expect(describeLink("https://x.com/paulg")).toMatchObject({ service: "x", label: "@paulg" });
    expect(describeLink("https://x.com/i/status/1839291043128172544")).toMatchObject({ service: "x", label: "Post on X" });
  });

  /* The app's own sections share the profile's shape, and `@home` would be a chip naming a person
     who does not exist. */
  it("does not read an X section as a person", () => {
    for (const url of ["https://x.com/home", "https://x.com/explore", "https://x.com/messages", "https://x.com/settings/account", "https://x.com/search?q=realm", "https://x.com/i"]) {
      expect(describeLink(url), url).toBeNull();
    }
    expect(describeLink("https://x.com/paulg/likes")).toBeNull(); // a tab, not a post
    expect(describeLink("https://x.com")).toBeNull();
  });

  it("refuses what it cannot name — a wrong chip is worse than a URL", () => {
    expect(describeLink("https://example.com/anything")).toBeNull();
    expect(describeLink("https://slack.com/pricing")).toBeNull();
    expect(describeLink("not a url")).toBeNull();
    expect(describeLink("ftp://linear.app/x")).toBeNull();
  });
});

describe("link chips on the wire", () => {
  it("expands a draft's link tokens to markdown and leaves element chips alone", () => {
    const links = [{ label: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/x", service: "linear" as const }];
    expect(expandLinkChips('fix @[ENG-123] like @[button "Save"]', links)).toBe('fix [ENG-123](https://linear.app/acme/issue/ENG-123/x) like @[button "Save"]');
  });

  it("draws a BARE url to a known app as a chip too, trailing punctuation left to the sentence", () => {
    /* A URL typed into a sentence is the same thing as one pasted alone, and should not read as a
       plain link once sent while its pasted twin reads as a chip. */
    const chips = scanLinkChips("see https://github.com/acme/realm/pull/42, then https://example.com/x.");
    expect(chips.map((c) => [c.label, c.url])).toEqual([["acme/realm#42", "https://github.com/acme/realm/pull/42"]]);
    expect(scanChips("[ENG-123](https://linear.app/acme/issue/ENG-123/x)", []).map((c) => c.kind)).toEqual(["link"]); // the href inside a markdown link is not a second chip
  });

  it("draws a sent markdown link to a known app back as a chip, and not a link to anywhere else", () => {
    const chips = scanLinkChips("see [ENG-123](https://linear.app/acme/issue/ENG-123/x) and [docs](https://example.com/d)");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ kind: "link", label: "ENG-123", service: "linear" });
    expect(scanChips("[ENG-123](https://linear.app/acme/issue/ENG-123/x)", []).map((c) => c.kind)).toEqual(["link"]);
  });
});

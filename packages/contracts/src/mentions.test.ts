import { describe, expect, it } from "vitest";
import { mentionIds, scanMentions, stripMentionAts } from "./mentions";

const IDS = ["mac", "mac-cli", "v1.2"];

describe("scanMentions", () => {
  it("finds an exact @id at the start, mid-text after whitespace, and at the end", () => {
    expect(scanMentions("@mac list my reminders", IDS)).toEqual([{ id: "mac", start: 0, end: 4 }]);
    expect(scanMentions("please use @mac-cli now", IDS)).toEqual([{ id: "mac-cli", start: 11, end: 19 }]);
    expect(scanMentions("try @v1.2", IDS)).toEqual([{ id: "v1.2", start: 4, end: 9 }]);
  });

  it("returns every occurrence in text order, including repeats of one id", () => {
    expect(scanMentions("@mac then @mac-cli then @mac", IDS).map((t) => t.id)).toEqual(["mac", "mac-cli", "mac"]);
  });

  it("never matches an email address — the @ must be token-initial", () => {
    expect(scanMentions("mail carlton@mac about it", IDS)).toEqual([]);
    expect(scanMentions("carlton@mac-cli.com", IDS)).toEqual([]);
  });

  it("never fuzzy-matches: the maximal id-character run must equal the id whole", () => {
    expect(scanMentions("@mac-extras please", IDS)).toEqual([]); // prefix of a longer run
    expect(scanMentions("run @mac. then stop", IDS)).toEqual([]); // '.' is a legal id char, so the run is 'mac.'
    expect(scanMentions("run @ma now", IDS)).toEqual([]); // shorter than any id
  });

  it("matches across newlines (a newline is whitespace) and after multiple spaces", () => {
    expect(scanMentions("first line\n@mac second", IDS)).toEqual([{ id: "mac", start: 11, end: 15 }]);
    expect(scanMentions("a  @mac", IDS).map((t) => t.id)).toEqual(["mac"]);
  });

  it("ignores a bare @, an unknown id, and an empty candidate set", () => {
    expect(scanMentions("@ mac", IDS)).toEqual([]);
    expect(scanMentions("@unknown", IDS)).toEqual([]);
    expect(scanMentions("@mac", [])).toEqual([]);
  });
});

describe("stripMentionAts", () => {
  const strip = (text: string, ids: string[] = IDS) => stripMentionAts(text, scanMentions(text, ids));

  it("removes exactly the @ of each token, leaving the sentence readable", () => {
    expect(strip("use @mac to list reminders")).toBe("use mac to list reminders");
    expect(strip("@mac then @mac-cli then @mac")).toBe("mac then mac-cli then mac");
  });

  it("leaves non-mention text byte-for-byte intact, including emails and unknown @tokens", () => {
    const text = "mail carlton@mac about @unknown and @mac";
    expect(strip(text)).toBe("mail carlton@mac about @unknown and mac");
  });

  it("is the identity for a mention-free message", () => {
    expect(strip("no mentions here")).toBe("no mentions here");
    expect(strip("")).toBe("");
  });
});

describe("mentionIds", () => {
  it("dedupes while keeping first-occurrence order — the resolution order the server uses", () => {
    expect(mentionIds("@mac-cli and @mac and @mac-cli again", IDS)).toEqual(["mac-cli", "mac"]);
  });
  it("is empty when nothing matches", () => {
    expect(mentionIds("plain text with user@mac inside", IDS)).toEqual([]);
  });
});

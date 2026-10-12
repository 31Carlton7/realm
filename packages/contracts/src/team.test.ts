import { describe, expect, it } from "vitest";
import { parseRecord, recordAccounts, recordField, recordSlug, weekStart } from "./team";

const NATHAN = `# Nathan Beyenhof
- Status: signed [source: realm:session/01M4AQ3QPKR38FR40JCCG9QSXA; added: 2026-10-07]
- Contact: Nathan.beyenhof@gmail.com · iMessage

## Deal
- Rate: $5 per video + $2.50 CPM
- Creator code: NATHAN5

## Accounts
- TikTok @versed.nathan · vault: tiktok.com/nathan · device: lab-iphone-2 · consent: contract §4
- YouTube Shorts: waiting on Nathan
`;

describe("parseRecord", () => {
  it("reads the head, the sections and their Key: value fields, metadata aside", () => {
    const r = parseRecord(NATHAN)!;
    expect(r.title).toBe("Nathan Beyenhof");
    expect(recordField(r, "status")).toBe("signed");
    expect(recordField(r, "Creator code", "deal")).toBe("NATHAN5");
    expect(r.sections.map((s) => s.heading)).toEqual(["Deal", "Accounts"]);
  });

  it("reads an account's handle, its parts and a line that is only a note", () => {
    const [tiktok, yt] = recordAccounts(parseRecord(NATHAN)!);
    expect(tiktok).toMatchObject({ channel: "TikTok", handle: "@versed.nathan", parts: { vault: "tiktok.com/nathan", device: "lab-iphone-2", consent: "contract §4" } });
    expect(yt).toMatchObject({ channel: "YouTube Shorts", handle: null, note: "waiting on Nathan" });
  });

  it("is null — the Markdown is shown instead — for a file that is not in the record's shape", () => {
    /* THE mutant: a parser that skips what it does not understand draws a half-form over prose. */
    expect(parseRecord("Notes about Nathan\n- Status: signed")).toBeNull();
    expect(parseRecord(`${NATHAN}\nHe said he'd send the contract Friday.`)).toBeNull();
  });
});

describe("helpers", () => {
  it("slugs a name for its file, and starts a week on Monday", () => {
    expect(recordSlug("Nathan Beyenhof")).toBe("nathan-beyenhof");
    expect(recordSlug("Zoë  O'Neil!")).toBe("zoe-o-neil");
    const thu = new Date(2026, 9, 8, 15, 0).getTime();
    expect(new Date(weekStart(thu))).toEqual(new Date(2026, 9, 5, 0, 0));
  });
});

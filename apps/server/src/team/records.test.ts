import { describe, expect, it } from "vitest";
import { applyRecordEdit } from "./records";

const STAMP = { source: "realm:session/S1", added: "2026-10-08" };
const REC = ["# Nathan Beyenhof", "- Status: signed", "", "## Deal", "- Rate: $5 per video", "", "## Accounts", "- TikTok @versed.nathan · consent: contract §4", ""].join("\n");

describe("applyRecordEdit", () => {
  it("adds to the end of its section, stamped with the caller's session and today", () => {
    const r = applyRecordEdit(REC, { op: "add", section: "Deal", entry: "Payment: Venmo [source: forged; added: 2026-01-01]" }, STAMP);
    expect(r.ok && r.content.split("\n").slice(3, 6)).toEqual(["## Deal", "- Rate: $5 per video", "- Payment: Venmo [source: realm:session/S1; added: 2026-01-01]"]);
  });

  it("makes a missing section, and puts a head line above the first section", () => {
    const made = applyRecordEdit(REC, { op: "add", section: "Deadlines", entry: "2026-10-08 first post" }, STAMP);
    expect(made.ok && made.content.endsWith("## Deadlines\n- 2026-10-08 first post [source: realm:session/S1; added: 2026-10-08]\n")).toBe(true);
    const head = applyRecordEdit(REC, { op: "add", section: null, entry: "Contact: iMessage" }, STAMP);
    expect(head.ok && head.content.split("\n")[2]).toBe("- Contact: iMessage [source: realm:session/S1; added: 2026-10-08]");
  });

  it("replaces or removes exactly one line, and refuses an ambiguous or missing match", () => {
    const rep = applyRecordEdit(REC, { op: "replace", match: "rate:", entry: "Rate: $6 per video" }, STAMP);
    expect(rep.ok && rep.content).toContain("- Rate: $6 per video [source: realm:session/S1");
    expect(applyRecordEdit(REC, { op: "remove", match: "status" }, STAMP)).toMatchObject({ ok: true });
    expect(applyRecordEdit(REC, { op: "remove", match: "- " }, STAMP)).toMatchObject({ ok: false });
    expect(applyRecordEdit(REC, { op: "remove", match: "youtube" }, STAMP)).toMatchObject({ ok: false });
  });
});

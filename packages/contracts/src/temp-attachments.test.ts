import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { givenAttachmentName, prefixedAttachmentName, tempAttachmentDir } from "./temp-attachments";

describe("a file's name in the attachments folder", () => {
  const dir = tempAttachmentDir("/Users/me/Realm");

  it("reads back as the name it was written under, prefix and all left off", () => {
    const written = prefixedAttachmentName("IMG_0042.jpg");
    // THE MUTANT: a writer whose prefix the reader does not know, and every file keeps it on the phone.
    expect(written).toMatch(/^[0-9a-f]{12}-IMG_0042\.jpg$/);
    expect(givenAttachmentName(join(dir, written), dir)).toBe("IMG_0042.jpg");
    expect(prefixedAttachmentName("a.png")).not.toBe(prefixedAttachmentName("a.png"));
  });

  it("is a file's own name anywhere else, or with no folder to look in", () => {
    expect(givenAttachmentName("/Users/me/report-v2.pdf", dir)).toBe("report-v2.pdf");
    expect(givenAttachmentName("/Users/me/Downloads/0123456789ab-notes.md", dir)).toBe("0123456789ab-notes.md");
    expect(givenAttachmentName(join(dir, "0123456789ab-notes.md"), null)).toBe("0123456789ab-notes.md");
    expect(givenAttachmentName(join(dir, "report-v2.pdf"), dir)).toBe("report-v2.pdf");
  });
});

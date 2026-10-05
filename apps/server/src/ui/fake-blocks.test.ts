import { describe, expect, it } from "vitest";
import { parseUiBlock, uiBlockKind } from "@realm/contracts";
import { FAKE_BLOCK_SCRIPT } from "./fake-blocks";

/** The scripted turns are what the live check judges the blocks by, so they must stay what they
 *  claim: one block of each kind that parses, and exactly one that does not, for the stated reason. */

const fences = (text: string) => [...text.matchAll(/```([\w-]+)\n([\s\S]*?)\n```/g)].map((m) => ({ kind: uiBlockKind(m[1]!)!, body: m[2]! }));
const said = (on: string) => FAKE_BLOCK_SCRIPT.find((s) => s.on === on)!.emit.flatMap((st) => (st.kind === "text" ? [st.text] : []));

describe("the scripted block turns", () => {
  it("draw one of each block and one that stays code, in the reply and in the document it writes", () => {
    const reply = fences(said("draw the blocks")[0]!);
    const write = FAKE_BLOCK_SCRIPT[0]!.emit.find((st) => st.kind === "tool");
    const doc = fences(String(write?.kind === "tool" ? write.input["content"] : ""));
    for (const blocks of [reply, doc]) {
      expect(blocks.map((b) => b.kind)).toEqual(["chart", "diagram", "compare", "chart"]);
      const parsed = blocks.map((b) => parseUiBlock(b.kind, b.body));
      expect(parsed.slice(0, 3).every((p) => p.ok)).toBe(true);
      expect(parsed[3]).toEqual({ ok: false, reason: '"Cold" has 2 values for 3 x labels' });
    }
  });

  it("cover every chart kind between them", () => {
    const kinds = [...said("draw the blocks"), ...said("draw the other charts")].flatMap((t) => fences(t))
      .flatMap((b) => { const p = parseUiBlock(b.kind, b.body); return p.ok && p.block.kind === "chart" ? [p.block.chart.kind] : []; });
    expect(new Set(kinds)).toEqual(new Set(["columns", "bars", "lines", "sparkline"]));
  });
});

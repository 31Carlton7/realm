import { describe, expect, it } from "vitest";
import { brandMarks, isBrandName } from "./brand-icons";

describe("brand marks", () => {
  it("covers every provider the prompter can name", () => {
    expect(Object.keys(brandMarks).sort()).toEqual([
      "claude", "cursor", "deepseek", "figma", "fx", "gemini", "github", "githubCopilot", "goose", "grok", "jira", "kimi", "linear", "meta", "notion", "openai", "opencode", "openhands", "qwen", "sentry", "slack", "zai",
    ]);
  });

  it("every mark carries valid path data from its source asset", () => {
    for (const [name, mark] of Object.entries(brandMarks)) {
      const paths: readonly string[] = typeof mark.d === "string" ? [mark.d] : mark.d;
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^[Mm]/);
        expect(d.length, name).toBeGreaterThan(10);
      }
    }
  });

  it("keeps the even-odd fill on the OpenAI blossom and only there", () => {
    // Preserve the fill rule declared by the source SVGs; removing it turns their negative space
    // into solid blobs. Marks absent from this list intentionally use SVG's nonzero default.
    expect(Object.entries(brandMarks).filter(([, m]) => "evenOdd" in m).map(([n]) => n)).toEqual([
      "openai", "opencode", "githubCopilot", "zai",
    ]);
  });

  it("carries the vendor's colour on exactly the marks whose vendor has one", () => {
    // Anthropic's coral spark, Gemini's blue and DeepSeek's whale blue are the vendors' own; OpenAI
    // and Cursor publish no single glyph colour, so their marks declare none — inventing one would be
    // a wrong statement about the trademark, not a design choice.
    expect(brandMarks.claude.color).toBe("#D97757");
    expect(brandMarks.gemini.color).toBe("#4796E3");
    expect(brandMarks.deepseek.color).toBe("#5786FE");
    expect(brandMarks.meta.color).toBe("#0467DF");
    expect(Object.entries(brandMarks).filter(([, m]) => "color" in m).map(([n]) => n).sort()).toEqual(["claude", "deepseek", "figma", "gemini", "jira", "linear", "meta", "sentry", "slack"]);
  });

  it("isBrandName accepts the marks and rejects Hugeicons names", () => {
    expect(isBrandName("claude")).toBe(true);
    expect(isBrandName("openai")).toBe(true);
    expect(isBrandName("goose")).toBe(true);
    expect(isBrandName("bot")).toBe(false);
    expect(isBrandName("toString")).toBe(false); // own-property check, not a prototype walk
  });
});

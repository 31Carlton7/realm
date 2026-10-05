import { describe, expect, it } from "vitest";
import { brandMarks, isBrandName } from "./brand-icons";

describe("brand marks", () => {
  it("covers every provider the prompter can name, and every machine vendor the connect form can", () => {
    /* Three sets, one list. The agents are what the prompter's model chip names; the eight machine
       vendors are what "Connect a machine" names — who is on the other end of an address; and the
       link services are what a pasted URL can become a chip for (`describeLink`). E2B's and
       Namespace's come from the vendors' own sites rather than from the two icon sets this file
       otherwise draws on, because neither set carries them; both entries say so. */
    expect(Object.keys(brandMarks).sort()).toEqual([
      "alpine", "android", "apple", "claude", "cursor", "debian", "deepseek", "e2b", "figma", "fx", "gemini", "github", "githubCopilot", "goose", "grok", "jira", "kimi", "linear", "meta", "modal", "namespace", "notion", "openai", "opencode", "openhands", "qwen", "sentry", "slack", "ubuntu", "vercel", "x", "zai",
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
    /* Namespace joins them for a different reason than the rest: its source paints a white N onto a
       blue disc, which needs two fills, and even-odd turns the same three paths into a disc with the
       N knocked out of it — one fill, and correct on either ground. */
    expect(Object.entries(brandMarks).filter(([, m]) => "evenOdd" in m).map(([n]) => n)).toEqual([
      "openai", "opencode", "githubCopilot", "zai", "namespace",
    ]);
  });

  it("isBrandName accepts the marks and rejects Hugeicons names", () => {
    expect(isBrandName("claude")).toBe(true);
    expect(isBrandName("openai")).toBe(true);
    expect(isBrandName("goose")).toBe(true);
    expect(isBrandName("bot")).toBe(false);
    expect(isBrandName("toString")).toBe(false); // own-property check, not a prototype walk
  });
});

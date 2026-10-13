import { act, render } from "@testing-library/react";
import hljs from "highlight.js/lib/core";
import { describe, expect, it } from "vitest";
import { Markdown, renderMarkdown } from "../Markdown";
import { CodeBlock } from "./ToolViews";
import { GRAMMARS, grammarFor } from "./highlight";
import { loadRichLibs } from "./rich-libs";

/** KaTeX and highlight.js are their own chunk, loaded after the window is up. Until they land, prose
 *  draws its plain fallback; when they land, everything already drawn draws again with them. The
 *  cases run in order: the first ones see the libraries absent, the last ones see them arrive. */

const PROSE = "```ts\nconst a = 1;\n```\n\nthe area is $x^2$";

describe("before KaTeX and highlight.js have loaded", () => {
  it("draws code uncoloured and TeX as its source, rather than waiting", () => {
    const html = renderMarkdown(PROSE);
    expect(html).not.toContain("hljs-");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("katex");
    expect(html).toContain('<span class="math-pending">$x^2$</span>');
  });

  it("still knows which fence labels have a grammar", () => {
    expect(grammarFor("tsx")).toBe("typescript");
    expect(grammarFor("cc")).toBe("cc");
    expect(grammarFor("wat")).toBeNull();
  });
});

describe("when they land", () => {
  it("redraws the prose and the code blocks already on screen", async () => {
    const { container } = render(<><Markdown text={PROSE} /><CodeBlock text={"let b = 2;"} lang="typescript" /></>);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    await act(loadRichLibs);
    expect(container.querySelector(".md .hljs-keyword")).toHaveTextContent("const");
    expect(container.querySelector(".md .katex")).not.toBeNull();
    expect(container.querySelector(".code-body .hljs-keyword")).toHaveTextContent("let");
  });

  it("names exactly the grammars highlight.js registered, with their own aliases", () => {
    const registered = Object.fromEntries(hljs.listLanguages().map((name) => [name, hljs.getLanguage(name)?.aliases ?? []]));
    expect(GRAMMARS).toEqual(registered);
  });
});

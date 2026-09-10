import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, renderMarkdown } from "./Markdown";

/** Plan 24 W1: what assistant prose renders as beyond paragraphs — highlighted code, TeX, GitHub
 *  admonitions, task lists. Every one of these is markup the model produced, so each case also has
 *  to still come out the far side of DOMPurify. */

const html = (md: string) => renderMarkdown(md);

describe("syntax highlighting", () => {
  it("tokenises a fence whose language it knows", () => {
    const out = html("```ts\nconst a = 1;\n```");
    expect(out).toContain('class="hljs-keyword"');
    expect(out).toContain("const");
  });

  it("maps the labels agents actually write onto the grammar that handles them", () => {
    expect(html("```tsx\nconst a = <div />;\n```")).toContain("hljs-");
    expect(html("```sh\nls -la\n```")).toContain("hljs-");
    expect(html("```py\nimport os\n```")).toContain("hljs-");
  });

  it("leaves an unlabelled or unknown fence alone rather than guessing at its language", () => {
    // A wrong guess reads as a different language and the reader cannot tell it was a guess.
    expect(html("```\nplain text\n```")).not.toContain("hljs-");
    expect(html("```wat\nplain text\n```")).not.toContain("hljs-");
  });

  it("still escapes what it highlights", () => {
    const out = html("```ts\nconst a = '<img src=x onerror=alert(1)>';\n```");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("keeps the language label and copy control the code panel already had", () => {
    const out = html("```ts\nconst a = 1;\n```");
    expect(out).toContain('<span class="md-code-lang">ts</span>');
    expect(out).toMatch(/aria-label="Copy code"/);
  });

  it("the copy button still yields the fence's exact source, tokens and all", () => {
    const { container } = render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(container.querySelector("pre")!.textContent).toBe("const a = 1;\n");
  });
});

describe("math", () => {
  it("sets display TeX in its own scrolling row", () => {
    const out = html("$$\\int_0^1 x^2\\,dx$$");
    expect(out).toContain('class="math-display"');
    expect(out).toContain("katex");
  });

  it("sets inline TeX in the flow of the sentence", () => {
    const out = html("the value of $x^2$ here");
    expect(out).toContain("katex");
    expect(out).not.toContain("math-display");
  });

  it("accepts the LaTeX bracket delimiters too", () => {
    expect(html("\\(a+b\\)")).toContain("katex");
    expect(html("\\[a+b\\]")).toContain("math-display");
  });

  it("keeps KaTeX's MathML through the sanitizer, so the expression stays selectable and readable", () => {
    // The html profile alone strips <math>, which takes the accessible half of every formula with it.
    expect(html("$x^2$")).toContain("<math");
  });

  it("leaves ordinary dollar signs alone", () => {
    // Prices and shell variables are far more common in a transcript than inline TeX, and one
    // greedy `$…$` match swallows the sentence between them.
    expect(html("it costs $5 and sells for $9")).not.toContain("katex");
    expect(html("echo $HOME and $PATH")).not.toContain("katex");
    expect(html("a $ b $ c")).not.toContain("katex");
  });

  it("never reads inside a code span or a fence as math", () => {
    expect(html("`$x^2$`")).not.toContain("katex");
    expect(html("```sh\necho $A $B\n```")).not.toContain("katex");
  });

  it("shows TeX it cannot parse as the source the agent wrote, not as a red error", () => {
    const out = html("$\\notarealmacro{x}$");
    expect(out).toContain("math-raw");
    expect(out).not.toContain("ParseError");
  });
});

describe("callouts", () => {
  it("gives a GitHub admonition its own kind and a header", () => {
    const out = html("> [!WARNING]\n> Do not do that.");
    expect(out).toContain('data-kind="warning"');
    expect(out).toContain('class="md-callout-head">Warning<');
    expect(out).toContain("Do not do that.");
  });

  it("keeps text written on the marker's own line as the body's first paragraph", () => {
    const out = html("> [!NOTE] worth knowing\n> and more");
    expect(out).toContain("worth knowing");
    expect(out).toContain("and more");
  });

  it("leaves an ordinary blockquote — and an unknown marker — as a blockquote", () => {
    expect(html("> just a quote")).not.toContain("md-callout");
    expect(html("> [!SOMETHING]\n> body")).not.toContain("md-callout");
  });
});

describe("task lists", () => {
  it("keeps GFM's checkboxes through the sanitizer", () => {
    const out = html("- [x] done\n- [ ] not done");
    expect(out.match(/<input[^>]*type="checkbox"/g)).toHaveLength(2);
    expect(out).toContain("checked");
  });
});

describe("links to apps the agent can reach", () => {
  it("are drawn as chips — the app's mark and a name — with the URL on the title, still an anchor", () => {
    /* The user's message shows a pasted Slack link as a chip; the assistant's answer citing the same
       thread must not show it as ninety characters of URL. The mutant: leave the anchor as written. */
    const out = html("See https://github.com/acme/realm/pull/42 and [the thread](https://acme.slack.com/archives/C01/p1712345678123456).");
    expect(out).toContain('class="msg-chip" data-kind="link" data-service="github"');
    expect(out).toContain('title="https://github.com/acme/realm/pull/42"');
    expect(out).toContain(">acme/realm#42</a>");
    expect(out).toContain('data-service="slack"');
    expect(out).toContain(">the thread</a>"); // the agent's own words for it win
    expect(out).toContain('<svg class="msg-chip-mark"');
  });

  it("leaves a link to anywhere else as the agent wrote it", () => {
    const out = html("Read https://example.com/docs first.");
    expect(out).not.toContain("msg-chip");
    expect(out).toContain('href="https://example.com/docs"');
  });
});

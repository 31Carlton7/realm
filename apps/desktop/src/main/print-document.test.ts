import { describe, expect, it, vi } from "vitest";
import { buildPrintDocument, linkTarget, type ReadImage } from "./print-document";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const noImages: ReadImage = async () => null;
const build = (path: string, text: string, readImage = noImages) => buildPrintDocument({ path, text, readImage });
const bodyOf = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

describe("the page a document prints as", () => {
  /* THE mutants: raw HTML passed through as markup, or a handler surviving as an attribute. */
  it("writes a document's raw HTML out as its source, as the documents pane does", async () => {
    const { html } = await build("/w/x.md", 'Hi <img src="a.png" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<iframe src="https://evil.test"></iframe>\n');
    const body = bodyOf(html);
    expect(body.querySelector("script, iframe, img")).toBeNull();
    expect(body.querySelector("[onerror]")).toBeNull();
    expect(body.textContent).toContain('<img src="a.png" onerror="alert(1)">');
    expect(body.querySelector("pre.raw-html")?.textContent).toBe("<script>alert(2)</script>");
  });

  it("draws a link only to the web, mail or a place in the page", async () => {
    const { html } = await build("/w/x.md", "[a](javascript:alert(1)) [b](JAVASCRIPT:x) [c](file:///etc/passwd) [d](https://realm.computer) [e](mailto:a@b.c) [f](#notes)");
    const hrefs = Array.from(bodyOf(html).querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://realm.computer/", "mailto:a@b.c", "#notes"]);
    expect(Array.from(bodyOf(html).querySelectorAll(".dead-link")).map((s) => s.textContent)).toEqual(["a", "b", "c"]);
    expect(linkTarget(" data:text/html,x")).toBeNull();
    expect(linkTarget("java\tscript:alert(1)")).toBeNull();
  });

  /* THE mutant: a remote picture handed to the page, which would fetch it. */
  it("never fetches a remote picture: it prints as a link to it, as the pane never loads one", async () => {
    const readImage = vi.fn(noImages);
    const { html } = await build("/w/x.md", "![the chart](https://example.com/chart.png) ![](//cdn.test/x.png)", readImage);
    const body = bodyOf(html);
    expect(body.querySelector("img")).toBeNull();
    expect(Array.from(body.querySelectorAll("a.left-out")).map((a) => [a.textContent, a.getAttribute("href")]))
      .toEqual([["the chart", "https://example.com/chart.png"]]);
    expect(body.querySelector("span.left-out")?.textContent).toBe("x.png");
    expect(readImage).not.toHaveBeenCalled();
  });

  it("embeds a picture main read beside the file, and only a raster one", async () => {
    const readImage = vi.fn(async (href: string) => (href === "shot.png" ? PNG : href === "logo.svg" ? "data:image/svg+xml;base64,PHN2Zz4=" : null));
    const { html } = await build("/w/x.md", `![shot](shot.png) ![logo](logo.svg) ![gone](gone.png) ![inline](${PNG})`, readImage);
    const imgs = Array.from(bodyOf(html).querySelectorAll("img")).map((i) => [i.getAttribute("alt"), i.getAttribute("src")]);
    expect(imgs).toEqual([["shot", PNG], ["inline", PNG]]);
    expect(readImage.mock.calls.map((c) => c[0])).toEqual(["shot.png", "logo.svg", "gone.png"]);
  });

  it("is titled by its first heading, else by the file's name", async () => {
    expect((await build("/w/notes.md", "intro\n\n## The **real** plan\n\n# Later")).title).toBe("The real plan");
    expect((await build("/w/notes.md", "no heading here")).title).toBe("notes.md");
    const { html } = await build("/w/a.md", "# A <b> & co");
    expect(html).toContain("<title>A &lt;b&gt; &amp; co</title>");
  });

  it("asks for nothing but its own styles, data: fonts and data: pictures", async () => {
    const { html } = await build("/w/a.md", "# A");
    const csp = new DOMParser().parseFromString(html, "text/html").querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    expect(csp).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'");
  });

  it("typesets TeX with KaTeX, inline and on its own line, and leaves TeX that will not parse as its source", async () => {
    const body = bodyOf((await build("/w/m.md", "Euler: $e^{i\\pi}+1=0$\n\n$$\\int_0^1 x^2\\,dx$$\n\nbad: $\\frac{1$")).html);
    expect(body.querySelectorAll(".katex").length).toBe(2);
    expect(body.querySelector(".math-display .katex-display")).not.toBeNull();
    expect(body.querySelector("code.math-raw")?.textContent).toBe("$\\frac{1$");
  });

  it("puts footnotes at the end of the page", async () => {
    const body = bodyOf((await build("/w/n.md", "# Notes\n\nA claim.[^1]\n\n[^1]: The source.\n")).html);
    expect(body.lastElementChild?.matches("section.footnotes")).toBe(true);
    expect(body.firstElementChild?.tagName).toBe("H1");
  });

  it("highlights fenced code in the page itself", async () => {
    const body = bodyOf((await build("/w/a.md", "```ts\nconst a = 1;\n```")).html);
    expect(body.querySelector("pre code.hljs .hljs-keyword")?.textContent).toBe("const");
  });
});

describe("the page a code file prints as", () => {
  it("is one highlighted block of the whole file under its name", async () => {
    const { html, title } = await build("/w/src/main.py", "def f():\n    return '<b>'\n");
    const body = bodyOf(html);
    expect(title).toBe("main.py");
    expect(body.querySelector("h1.file-name")?.textContent).toBe("main.py");
    expect(body.querySelectorAll("pre").length).toBe(1);
    expect(body.querySelector("pre.file .hljs-keyword")?.textContent).toBe("def");
    expect(body.querySelector("pre.file")?.textContent).toBe("def f():\n    return '<b>'\n");
  });

  it("leaves a file whose language is not registered uncoloured, and escaped", async () => {
    const body = bodyOf((await build("/w/notes.txt", "<script>x</script>")).html);
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("pre.file")?.innerHTML).toBe('<code class="hljs">&lt;script&gt;x&lt;/script&gt;</code>');
  });
});

describe("the page a sheet prints as", () => {
  it("is a table whose first row is its header, numbers right-aligned", async () => {
    const body = bodyOf((await build("/w/q3.csv", 'Region,Revenue,Note\nWest,"1,200",<b>x</b>\nEast,950\n')).html);
    expect(Array.from(body.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["Region", "Revenue", "Note"]);
    const rows = Array.from(body.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.children).map((td) => td.textContent));
    expect(rows).toEqual([["West", "1,200", "<b>x</b>"], ["East", "950", ""]]);
    expect(Array.from(body.querySelectorAll("td.num")).map((td) => td.textContent)).toEqual(["1,200", "950"]);
    expect(body.querySelector("tbody b")).toBeNull();
  });

  it("reads a .tsv by tabs", async () => {
    const body = bodyOf((await build("/w/t.tsv", "a\tb\n1\t2\n")).html);
    expect(Array.from(body.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["a", "b"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { DocumentPreviewServer, GUIDE_CSP, defaultKatexDir, defaultVisNetworkDir, injectHelpers, localizeVisNetwork, wantsKatex } from "./preview";
import { makePdf } from "./test-pdf";

const servers: DocumentPreviewServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

async function boot(katexDir?: string | null, visNetworkDir?: string | null) {
  const root = tempDir("realm-preview-");
  const s = new DocumentPreviewServer({ rootOf: (id) => (id === "ws1" ? root : null), katexDir, visNetworkDir });
  servers.push(s);
  const port = await s.listen();
  const get = async (path: string, init?: RequestInit) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  return { s, root, port, get, base: `/p/${s.token}` };
}

describe("DocumentPreviewServer", () => {
  it("serves a guide with the runtime injected and its own strict CSP", async () => {
    const { root, get, base } = await boot(null);
    writeFileSync(join(root, "g.html"), "<!doctype html><html><head><title>t</title></head><body><script>1</script></body></html>");
    const r = await get(`${base}/ws1/g.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBe(GUIDE_CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text).toContain(`<script defer src="${base}/_realm/guide.js"></script>`);
    expect(r.text).toContain(`<link rel="stylesheet" href="${base}/_realm/guide.css">`);
    expect(r.text).not.toContain("katex"); // no opt-in meta → no KaTeX
    // Injected BEFORE </head>, so the author's own head content stays first.
    expect(r.text.indexOf("<title>t</title>")).toBeLessThan(r.text.indexOf("guide.js"));
  });

  it("refuses a bad or missing token, and a path that escapes the workspace", async () => {
    const { root, get, base } = await boot(null);
    writeFileSync(join(root, "g.html"), "<p>hi</p>");
    expect((await get(`/p/nope/ws1/g.html`)).status).toBe(404);
    expect((await get(`/ws1/g.html`)).status).toBe(404);
    expect((await get(`${base}/ws1/..%2F..%2Fetc%2Fpasswd`)).status).toBe(400);
    expect((await get(`${base}/ws1/%2Fetc%2Fpasswd`)).status).toBe(400);
    expect((await get(`${base}/other/g.html`)).status).toBe(404); // unknown workspace
    expect((await get(`${base}/ws1/missing.html`)).status).toBe(404);
  });

  it("streams a PDF and other assets with their MIME type and no injection", async () => {
    const { root, get, base } = await boot(null);
    mkdirSync(join(root, "slides"));
    writeFileSync(join(root, "slides", "l4.pdf"), makePdf(["Hello"]));
    writeFileSync(join(root, "fig.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const pdf = await get(`${base}/ws1/slides/l4.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.text.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.headers.get("content-security-policy")).toBeNull();
    const svg = await get(`${base}/ws1/fig.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.text).not.toContain("guide.js");
  });

  it("answers HEAD without a body and rejects other methods", async () => {
    const { root, get, base } = await boot(null);
    writeFileSync(join(root, "g.html"), "<p>hi</p>");
    const head = await get(`${base}/ws1/g.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
    expect((await get(`${base}/ws1/g.html`, { method: "POST" })).status).toBe(405);
  });

  it("serves the runtime helpers, and KaTeX only when a distribution is configured", async () => {
    const { get, base } = await boot(null);
    const js = await get(`${base}/_realm/guide.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.text).toContain("realm-guide:attempt");
    expect((await get(`${base}/_realm/guide.css`)).text).toContain(".rg-quiz");
    expect((await get(`${base}/_realm/katex/katex.min.js`)).status).toBe(404);
    expect((await get(`${base}/_realm/nope.js`)).status).toBe(404);
  });

  it("with the vendored KaTeX, injects it for an opted-in guide and serves the files and fonts", async () => {
    const katex = defaultKatexDir();
    expect(katex).not.toBeNull();
    const { root, get, base } = await boot(katex);
    writeFileSync(join(root, "m.html"), '<html><head><meta name="realm-helpers" content="katex"></head><body>$x$</body></html>');
    const r = await get(`${base}/ws1/m.html`);
    expect(r.text).toContain(`${base}/_realm/katex/katex.min.js`);
    expect(r.text).toContain(`${base}/_realm/katex/auto-render.min.js`);
    expect(r.text).toContain(`${base}/_realm/katex/katex.min.css`);
    // KaTeX before the runtime, so renderMathInElement exists when the runtime's init runs.
    expect(r.text.indexOf("auto-render.min.js")).toBeLessThan(r.text.indexOf("guide.js"));
    expect((await get(`${base}/_realm/katex/katex.min.js`)).status).toBe(200);
    expect((await get(`${base}/_realm/katex/katex.min.css`)).headers.get("content-type")).toContain("text/css");
    expect((await get(`${base}/_realm/katex/auto-render.min.js`)).status).toBe(200);
    expect((await get(`${base}/_realm/katex/fonts/KaTeX_Main-Regular.woff2`)).status).toBe(200);
    expect((await get(`${base}/_realm/katex/README.md`)).status).toBe(404); // not a listing of the package
    expect((await get(`${base}/_realm/katex/fonts/..%2Fkatex.js`)).status).toBe(404);
  });

  it("with the vendored vis-network, points a graphify graph at it and serves the bundle", async () => {
    const vis = defaultVisNetworkDir();
    expect(vis).not.toBeNull();
    const { root, get, base } = await boot(null, vis);
    // The one script tag graphify's generated graph.html carries.
    writeFileSync(join(root, "graph.html"), '<html><head><script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script></head><body><div id="g"></div></body></html>');
    const r = await get(`${base}/ws1/graph.html`);
    expect(r.text).toContain(`<script src="${base}/_realm/vis-network/vis-network.min.js"></script>`);
    // The mutant this kills is leaving the CDN URL in place: GUIDE_CSP is default-src 'none', so
    // the bundle never loads and the graph renders blank rather than failing loudly.
    expect(r.text).not.toContain("unpkg.com");
    const bundle = await get(`${base}/_realm/vis-network/vis-network.min.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect(bundle.text).toContain("vis");
  });

  it("leaves a remote bundle alone when there is no vendored copy to point at", async () => {
    const { root, get, base } = await boot(null, null);
    writeFileSync(join(root, "graph.html"), '<html><head><script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script></head></html>');
    const r = await get(`${base}/ws1/graph.html`);
    // Rewriting to a helper route that 404s would be worse than leaving the URL: the page would
    // break identically, but the reason would no longer be visible in the markup.
    expect(r.text).toContain("unpkg.com");
    expect((await get(`${base}/_realm/vis-network/vis-network.min.js`)).status).toBe(404);
  });

  it("info() and urlFor() describe the listener; info() throws before listen", () => {
    const s = new DocumentPreviewServer({ rootOf: () => null, katexDir: null });
    expect(() => s.info()).toThrow(/not listening/);
    expect(s.token.length).toBeGreaterThan(16);
  });

  it("urlFor encodes each path segment", async () => {
    const { s, port, base } = await boot(null);
    expect(s.urlFor("ws1", "guides/cache coherence.html")).toBe(`http://127.0.0.1:${port}${base}/ws1/guides/cache%20coherence.html`);
  });
});

describe("localizeVisNetwork", () => {
  const src = (html: string) => localizeVisNetwork(html, "/b");

  it("rewrites the src whatever version or CDN the generator pinned", () => {
    // graphify moves its pin between releases, so matching the exact 9.1.6 URL would silently stop
    // working on the next upgrade — the mutant a version-pinned regex would introduce.
    expect(src('<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script>'))
      .toBe('<script src="/b/vis-network/vis-network.min.js"></script>');
    expect(src('<script src="https://cdn.jsdelivr.net/npm/vis-network@10.0.1/peer/umd/vis-network.min.js"></script>'))
      .toBe('<script src="/b/vis-network/vis-network.min.js"></script>');
  });

  it("drops the subresource integrity hash, which no longer describes what is being served", () => {
    // Exactly what graphify writes, newlines and all. Keeping `integrity` here was the first version of
    // this function: every string assertion passed and the browser still refused the script, because the
    // digest pins the CDN build's bytes and the vendored build is a different one.
    const real = '<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"\n'
      + '        integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1"\n'
      + '        crossorigin="anonymous">';
    const out = src(real);
    expect(out).toBe('<script src="/b/vis-network/vis-network.min.js">');
    expect(out).not.toContain("integrity");
    expect(out).not.toContain("crossorigin");
  });

  it("keeps the tag's unrelated attributes", () => {
    expect(src('<script defer src="https://unpkg.com/vis-network@9.1.6/x.js" id="vis"></script>'))
      .toBe('<script defer src="/b/vis-network/vis-network.min.js" id="vis"></script>');
  });

  it("leaves every other script alone", () => {
    const inline = "<script>const nodes = [];</script>";
    expect(src(inline)).toBe(inline);
    const other = '<script src="https://unpkg.com/d3@7/dist/d3.min.js"></script>';
    expect(src(other)).toBe(other);
    // A same-origin path that merely mentions the name is already local; rewriting it would break
    // a guide that ships its own copy.
    const local = '<script src="./vendor/vis-network.min.js"></script>';
    expect(src(local)).toBe(local);
  });
});

describe("injectHelpers / wantsKatex", () => {
  it("injects after <head>, or at the top when there is no head", () => {
    expect(injectHelpers("<html><head><title>x</title><body>b</body></html>", "/b", { katex: false }))
      .toMatch(/<head>\n<link[^]*guide\.js"><\/script><title>x<\/title>/);
    expect(injectHelpers("<p>bare</p>", "/b", { katex: false }).startsWith('<link rel="stylesheet" href="/b/guide.css">')).toBe(true);
  });
  it("reads the meta regardless of attribute order and case", () => {
    expect(wantsKatex('<META content="mermaid katex" NAME="realm-helpers">')).toBe(true);
    expect(wantsKatex('<meta name="realm-helpers" content="mermaid">')).toBe(false);
    expect(wantsKatex('<meta name="other" content="katex">')).toBe(false);
    expect(wantsKatex("<p>katex</p>")).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyTranscript, type Block, type Transcript } from "../transcript-model";
import { DEFAULT_SHARE_OPTIONS, type ShareOptions } from "./options";
import { IMAGE_CAP_BYTES, buildSharePage, safeUrl, sharedImagePaths, type SharedSession } from "./page";
import { PAGE_SCRIPT, PAGE_SCRIPT_HASH } from "./style";

const T0 = new Date(2026, 9, 18, 14, 2).getTime();
const at = (min: number, s = 0) => T0 + min * 60_000 + s * 1000;
const t = (blocks: Block[]): Transcript => ({ ...emptyTranscript(), blocks });
/** A base64 PNG body of about `bytes` — only its length and alphabet matter to the page. */
const png = (bytes: number) => `data:image/png;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;
const tail = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1p"[i % 16]).join("");

const session = (blocks: Block[], over: Partial<SharedSession> = {}): SharedSession => ({
  title: "Stream the tokenizer", space: "Widgets", agent: "Claude · Opus 5.5",
  transcript: t(blocks), permissions: [], images: {}, children: {}, now: at(90), ...over,
});

const build = (s: SharedSession, o: Partial<ShareOptions> = {}) => buildSharePage(s, { ...DEFAULT_SHARE_OPTIONS, ...o });
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const text = (doc: Document, sel: string) => [...doc.querySelectorAll(sel)].map((e) => e.textContent?.trim() ?? "");

/** A session in every shape the page draws. */
function sample(): SharedSession {
  const blocks: Block[] = [
    { kind: "user", text: "Make the tokenizer stream.\nKeep the parser's API.", attachments: [{ path: "/Users/bob/Desktop/trace.png", mime: "image/png" }, { path: "/Users/bob/notes.pdf", mime: "application/pdf" }], ts: at(0) },
    { kind: "thinking", messageId: "a0", text: "The read buffer is the problem.", ts: at(0, 5) },
    { kind: "assistant", messageId: "a1", text: "Reading the tokenizer first.", streaming: false, ts: at(0, 8) },
    { kind: "tool", toolUseId: "t1", name: "Read", input: { file_path: "/Users/bob/widgets/src/tokenizer.ts" }, result: { content: "     1\texport function tokenize(src: string) {\n     2\t  return src.split(' ');\n     3\t}", isError: false }, ts: at(0, 10) },
    { kind: "tool", toolUseId: "t2", name: "Bash", input: { command: "pnpm vitest run tokenizer" }, result: { content: "Tests  4 passed (4)", isError: false }, ts: at(0, 20) },
    { kind: "assistant", messageId: "a2", streaming: false, ts: at(1), text: [
      "# The change", "", "Two steps:", "", "1. Feed chunks", "2. Yield tokens", "",
      "| File | Lines |", "| --- | ---: |", "| tokenizer.ts | 42 |", "",
      "```ts", "export const feed = (chunk: string): void => {};", "```", "",
      "See [the spec](https://example.com/spec).",
    ].join("\n") },
    { kind: "tool", toolUseId: "t3", name: "Edit", input: { file_path: "/Users/bob/widgets/src/tokenizer.ts", old_string: "return src.split(' ');", new_string: "return stream(src);" }, result: { content: "Edited", isError: false }, ts: at(1, 30) },
    { kind: "tool", toolUseId: "t4", name: "Task", input: { description: "Check the parser tests", prompt: "Run the parser tests and say what fails.", subagent_type: "Explore" }, result: { content: "All **twelve** pass.", isError: false }, ts: at(2) },
    { kind: "tool", toolUseId: "t5", name: "Grep", parentToolUseId: "t4", input: { pattern: "describe\\(" }, result: { content: "src/parser.test.ts:1:describe('parser', () => {", isError: false }, ts: at(2, 10) },
    { kind: "tool", toolUseId: "t6", name: "mcp__realm__realm-agent__agent_start", input: { title: "Docs pass", goal: "Update the README for streaming" }, result: { content: "Started 01JB0000000000000000000000", isError: false }, ts: at(3) },
    { kind: "plan", planId: "p1", steps: [{ text: "Stream chunks", status: "completed" }, { text: "Update docs", status: "in_progress" }], ts: at(3, 30) },
    { kind: "question", requestId: "q1", input: {}, card: { asker: { kind: "agent", name: "Claude" }, mode: "question", questions: [{ id: "q", prompt: "Keep the old API?", kind: "choice" }] }, decision: "allow", answers: { q: "Yes" }, ts: at(4) },
    { kind: "tool", toolUseId: "t7", name: "Bash", input: { command: "rm -rf dist" }, result: { content: "Okay, I won't run that.", isError: true }, ts: at(4, 30) },
    { kind: "run", ms: 65_000, startedAt: at(0), ts: at(5) },
    { kind: "user", text: "Thanks!", ts: at(6) },
    { kind: "assistant", messageId: "a3", text: "Done.", streaming: false, ts: at(6, 5) },
  ] as Block[];
  return session(blocks, {
    images: { "/Users/bob/Desktop/trace.png": png(2000) },
    permissions: [
      { requestId: "r1", toolName: "Edit", input: { file_path: "/Users/bob/widgets/src/tokenizer.ts", old_string: "return src.split(' ');", new_string: "return stream(src);" }, title: "Allow Edit?", decision: "allow", ts: at(1, 31) },
      { requestId: "r2", toolName: "Bash", input: { command: "rm -rf dist" }, title: "Allow Bash?", decision: "deny", ts: at(4, 31) },
    ],
    children: { t6: [{ title: "Docs pass", agent: "Codex · GPT-6 Luna", permissions: [], transcript: t([
      { kind: "user", text: "Update the README for streaming", ts: at(3, 1) },
      { kind: "assistant", messageId: "c1", text: "The README now says the tokenizer streams.", streaming: false, ts: at(3, 20) },
    ] as Block[]) }] },
  });
}

describe("the page's structure", () => {
  const doc = parse(build(sample()).html);

  it("heads the page with the title, the space, when, who and how much", () => {
    expect(text(doc, "h1")).toEqual(["Stream the tokenizer"]);
    expect(text(doc, ".crumb")).toEqual(["Widgets"]);
    expect(doc.title).toBe("Stream the tokenizer");
    const facts = Object.fromEntries([...doc.querySelectorAll(".facts > div")].map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]));
    expect(facts).toEqual({
      Date: "Oct 18, 2026, 2:02 – 2:08 PM",
      Agent: "Claude · Opus 5.5",
      "Sub-agents": "2 on Claude · Opus 5.5 and Codex · GPT-6 Luna",
      Conversation: "5 messages · 2 turns",
    });
  });

  it("draws the prompt as a bubble and the answer as rendered Markdown, each with an anchor", () => {
    expect(text(doc, ".log > .msg-user .bubble")).toEqual(["Make the tokenizer stream.\nKeep the parser's API.", "Thanks!"]);
    const answer = doc.querySelectorAll(".log > .msg-agent")[1]!;
    // A `#` in an answer sits under the page's one h1.
    expect(answer.querySelector("h3")?.textContent).toBe("The change");
    expect(answer.querySelectorAll("ol > li")).toHaveLength(2);
    expect(answer.querySelector(".table td[align=right]")?.textContent).toBe("42");
    expect(answer.querySelector("figure.code figcaption")?.textContent).toBe("ts");
    // Highlighted when the page was made, so reading it needs no script.
    expect(answer.querySelector("figure.code .hljs-keyword")?.textContent).toBe("export");
    expect(answer.querySelector(".md a")?.getAttribute("href")).toBe("https://example.com/spec");
    const ids = [...doc.querySelectorAll(".msg")].map((m) => m.id);
    expect(ids.slice(0, 3)).toEqual(["m-1", "m-2", "m-3"]);
    for (const id of ids) expect(doc.querySelector(`#${id} > a.anchor`)?.getAttribute("href")).toBe(`#${id}`);
  });

  it("puts the picture inside the page and names the other file", () => {
    const prompt = doc.querySelector(".msg-user")!;
    expect(prompt.querySelector(".files img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(prompt.querySelector(".files img")?.getAttribute("alt")).toBe("trace.png");
    expect(text(prompt as unknown as Document, ".files .file")).toEqual(["notes.pdf"]);
  });

  it("folds a run of calls into one line that says what the work was", () => {
    const steps = doc.querySelector("details.steps")!;
    expect(steps.querySelector(":scope > summary")?.textContent).toBe("Worked1 read · 1 command");
    expect(text(steps as unknown as Document, ".body > details.call > summary .verb")).toEqual(["Read", "Run"]);
    const run = steps.querySelectorAll(".body > details.call")[1]!;
    expect(run.querySelector(".well")?.textContent).toBe("$ pnpm vitest run tokenizer\nTests  4 passed (4)");
  });

  it("draws an edit as a diff with signs and its count, and says the prompt was allowed", () => {
    const edit = [...doc.querySelectorAll("details.call")].find((d) => d.querySelector(".verb")?.textContent === "Edit")!;
    expect(edit.querySelector("summary .obj")?.textContent).toBe("tokenizer.ts");
    expect(edit.querySelector("summary .stat")?.textContent).toBe("+1 −1");
    expect(edit.querySelector("summary .tag")?.textContent).toBe("Allowed when asked");
    expect(text(edit as unknown as Document, ".diff tr[data-kind] .sign")).toEqual(["−", "+"]);
  });

  it("says a denied prompt on the line it was about", () => {
    const denied = [...doc.querySelectorAll(".call")].find((d) => d.querySelector(".obj")?.textContent === "rm -rf dist")!;
    expect(text(denied as unknown as Document, ".tag")).toEqual(["Denied when asked"]);
  });

  it("nests a harness sub-agent's ask, its calls and its report under it", () => {
    const agent = [...doc.querySelectorAll("details.agent")].find((d) => d.textContent?.includes("Check the parser tests"))!;
    expect(agent.querySelector("summary .tag")?.textContent).toBe("Explore · Finished");
    expect(text(agent as unknown as Document, ".agent-label")).toEqual(["Asked", "Reported"]);
    expect(agent.querySelector(".body > details.call .verb")?.textContent).toBe("Search");
    expect(agent.querySelector(".body > .md strong")?.textContent).toBe("twelve");
  });

  it("draws Realm's own sub-agent as its whole session, under the call that started it", () => {
    const agent = [...doc.querySelectorAll("details.agent")].find((d) => d.textContent?.includes("Docs pass"))!;
    expect(agent.querySelector("summary .tag")?.textContent).toBe("Codex · GPT-6 Luna");
    expect(text(agent as unknown as Document, ".msg-agent .md")).toEqual(["The README now says the tokenizer streams."]);
    // The brief Realm wrapped round the goal gives way to the goal, as the lead asked it.
    expect(text(agent as unknown as Document, ".agent-label")).toEqual(["Asked"]);
    expect(agent.querySelector(".body > .md")?.textContent?.trim()).toBe("Update the README for streaming");
    expect(agent.querySelectorAll(".msg-user")).toHaveLength(0);
  });

  it("draws the plan, the answered question, and how long the turn worked", () => {
    expect(text(doc, ".plan .todo li")).toEqual(["Stream chunks", "Update docs"]);
    expect(doc.querySelector(".plan .todo li")?.getAttribute("data-status")).toBe("completed");
    expect(text(doc, ".ask .q")).toEqual(["Keep the old API?"]);
    expect(text(doc, ".ask .a")).toEqual(["Yes"]);
    expect(text(doc, ".run")).toEqual(["Worked for 1m 5s"]);
  });

  it("lists the prompts beside a wide page, and signs off", () => {
    expect([...doc.querySelectorAll(".outline a")].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["#m-1", "Make the tokenizer stream."], ["#m-5", "Thanks!"]]);
    expect(doc.querySelector(".foot .made")?.textContent).toBe("Made with Realm");
    expect(text(doc, ".foot p")).toEqual(["Shared Oct 18, 2026"]);
  });
});

describe("what the person chose to include", () => {
  it("leaves the thinking out unless asked", () => {
    expect(DEFAULT_SHARE_OPTIONS.thinking).toBe(false);
    expect(build(sample()).html).not.toContain("The read buffer is the problem.");
    const doc = parse(build(sample(), { thinking: true }).html);
    expect(doc.querySelector("details.thinking .body")?.textContent?.trim()).toBe("The read buffer is the problem.");
  });

  it("keeps each call to its line without tool details", () => {
    const doc = parse(build(sample(), { tools: false }).html);
    expect(doc.querySelectorAll("details.call")).toHaveLength(0);
    expect(doc.querySelectorAll(".diff, .well")).toHaveLength(0);
    // The lines themselves stay: a reader still sees what was done.
    expect(text(doc, ".call .verb")).toEqual(expect.arrayContaining(["Read", "Run", "Edit"]));
    expect(doc.querySelector(".call .tag")?.textContent).toBe("Allowed when asked");
  });

  it("keeps each sub-agent to its line without sub-agents", () => {
    const doc = parse(build(sample(), { subagents: false }).html);
    expect(doc.querySelectorAll("details.agent")).toHaveLength(0);
    expect(text(doc, ".agent .obj")).toEqual(["Check the parser tests", "Docs pass"]);
    expect(doc.body.textContent).not.toContain("The README now says the tokenizer streams.");
  });

  it("names the picture instead of embedding it without images", () => {
    const doc = parse(build(sample(), { images: false }).html);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(text(doc, ".msg-user .file")).toEqual(["trace.png", "notes.pdf"]);
  });

  it("writes the home folder as ~ unless told not to", () => {
    const hidden = build(sample()).html;
    expect(hidden).not.toContain("/Users/bob");
    expect(hidden).toContain("~/widgets/src/tokenizer.ts");
    expect(build(sample(), { hidePaths: false }).html).toContain("/Users/bob/widgets/src/tokenizer.ts");
    // The picture is still found by its path once the path is written as ~.
    expect(parse(hidden).querySelector(".msg-user img")).not.toBeNull();
  });
});

describe("pictures", () => {
  const withPicture = (data: string) => session([{ kind: "user", text: "look", attachments: [{ path: "/tmp/a.png", mime: "image/png" }], ts: at(0) }], { images: { "/tmp/a.png": data } });

  it("leaves out a picture over its size, and says so", () => {
    const page = build(withPicture(png(IMAGE_CAP_BYTES + 1024)));
    const doc = parse(page.html);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelector(".left")?.textContent).toBe("a.png is not included: 1.5 MB is over the 1.5 MB a picture may take");
    expect(page.imagesLeftOut).toBe(1);
    expect(parse(build(withPicture(png(IMAGE_CAP_BYTES - 1024))).html).querySelectorAll("img")).toHaveLength(1);
  });

  it("stops embedding once the page's pictures reach their total", () => {
    const blocks: Block[] = Array.from({ length: 9 }, (_, i) => ({ kind: "user", text: `${i}`, attachments: [{ path: `/tmp/${i}.png`, mime: "image/png" }], ts: at(i) }) as Block);
    const images = Object.fromEntries(blocks.map((_, i) => [`/tmp/${i}.png`, png(1.4 * 1024 * 1024)]));
    const page = build(session(blocks, { images }));
    expect(parse(page.html).querySelectorAll("img")).toHaveLength(8);
    expect(page.imagesLeftOut).toBe(1);
  });

  it("embeds only a raster data URL", () => {
    for (const data of ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "https://example.com/a.png", "data:text/html;base64,PHNjcmlwdD4=", 'data:image/png;base64,AAAA" onerror="alert(1)']) {
      const doc = parse(build(withPicture(data)).html);
      expect(doc.querySelectorAll("img"), data).toHaveLength(0);
      expect(doc.querySelector(".file")?.textContent).toBe("a.png");
    }
  });

  it("asks for every picture the page could show", () => {
    expect(sharedImagePaths(t([
      { kind: "user", text: "", attachments: [{ path: "/a/shot.png", mime: "image/png" }, { path: "/a/doc.pdf", mime: "application/pdf" }], ts: 1 },
      { kind: "tool", toolUseId: "r", name: "Read", input: { file_path: "/a/read.jpg" }, result: { content: "", isError: false }, ts: 2 },
      { kind: "assistant", messageId: "m", text: "![chart](out/chart.png) and ![x](https://example.com/x.png)", streaming: false, ts: 3 },
    ] as Block[]))).toEqual(["/a/shot.png", "/a/read.jpg", "out/chart.png"]);
  });

  it("draws an answer's local picture from what it was handed, and never loads a remote one", () => {
    const doc = parse(build(session([{ kind: "assistant", messageId: "m", text: "![chart](out/chart.png)\n\n![remote](https://example.com/x.png)", streaming: false, ts: at(0) }],
      { images: { "out/chart.png": png(500) } })).html);
    expect(doc.querySelectorAll("img")).toHaveLength(1);
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe("chart");
    expect(doc.querySelector(".md a")?.getAttribute("href")).toBe("https://example.com/x.png");
  });
});

describe("secrets", () => {
  const key = `ghp_${tail(36)}`;

  it("hides a key wherever it appears and says how many it hid", () => {
    const page = build(session([
      { kind: "user", text: `my token is ${key}`, ts: at(0) },
      { kind: "assistant", messageId: "m", text: `Set \`GITHUB_TOKEN=${key}\` and see [docs](https://example.com/?t=${key}).`, streaming: false, ts: at(1) },
      { kind: "tool", toolUseId: "b", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${tail(30)}" api` }, result: { content: `token=${key}`, isError: false }, ts: at(2) },
    ] as Block[], { title: `Rotate ${key}` }));
    expect(page.html).not.toContain(tail(30));
    expect(page.hidden).toBe(6);
    const doc = parse(page.html);
    expect(doc.title).toBe("Rotate [hidden]");
    expect(doc.querySelector(".bubble .secret")?.textContent).toBe("[hidden]");
    expect(doc.querySelector(".md code .secret")?.textContent).toBe("[hidden]");
    // Inside an attribute a hidden value is its word, never markup.
    expect(doc.querySelector(".md a")?.getAttribute("href")).toBe("https://example.com/?t=[hidden]");
    expect(text(doc, ".foot p")[1]).toBe("Realm hid 6 values that looked like a key or a token.");
  });

  it("cannot be told a value is hidden by the transcript itself", () => {
    const page = build(session([{ kind: "user", text: "a \uE000 b", ts: at(0) }]));
    expect(page.hidden).toBe(0);
    expect(parse(page.html).querySelectorAll(".secret")).toHaveLength(0);
    expect(parse(page.html).querySelector(".bubble")?.textContent).toBe("a  b");
  });
});

describe("untrusted text", () => {
  const payloads = [
    `<script>alert(1)</script>`,
    `<img src=x onerror=alert(1)>`,
    `<svg onload=alert(1)><a xlink:href="javascript:alert(1)">x</a></svg>`,
    `"><iframe src="https://evil.example"></iframe>`,
    `</style><style>body{display:none}</style>`,
    `</title><script>alert(1)</script>`,
    `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
    `<base href="https://evil.example/">`,
    `<form action="https://evil.example"><button>Go</button></form>`,
    `<details open ontoggle=alert(1)>x</details>`,
    `[click](javascript:alert(1))`,
    `[click](JAVASCRIPT:alert(1))`,
    `[click](java\tscript:alert(1))`,
    `[click](&#106;avascript:alert(1))`,
    `[click](data:text/html,<script>alert(1)</script>)`,
    `[click](vbscript:msgbox(1))`,
    `[click](https://ok.example "a\\" onmouseover=\\"alert(1))`,
    `<javascript:alert(1)>`,
    `![x](javascript:alert(1))`,
    `![x](x" onerror="alert(1))`,
    "```\"><script>alert(1)</script>\nboom\n```",
    "``` onload=alert(1)\nx\n```",
    `<a href="https://evil.example" onclick="alert(1)">x</a>`,
    `<style>@import url(https://evil.example/x.css)</style>`,
  ];
  const everywhere = (p: string): SharedSession => session([
    { kind: "user", text: p, attachments: [{ path: `/tmp/${p}.png`, mime: "image/png" }], from: { sessionId: "s", title: p }, ts: at(0) },
    { kind: "assistant", messageId: "m", text: p, streaming: false, ts: at(1) },
    { kind: "thinking", messageId: "m0", text: p, ts: at(1) },
    { kind: "tool", toolUseId: "t1", name: p, input: { [p]: p, command: p }, result: { content: p, isError: false }, ts: at(2) },
    { kind: "tool", toolUseId: "t2", name: "Bash", input: { command: p }, result: { content: p, isError: true }, ts: at(2) },
    { kind: "tool", toolUseId: "t3", name: "Edit", input: { file_path: p, old_string: p, new_string: `${p}!` }, result: { content: p, isError: false }, ts: at(2) },
    { kind: "tool", toolUseId: "t4", name: "Task", input: { description: p, prompt: p }, result: { content: p, isError: false }, ts: at(3) },
    { kind: "tool", toolUseId: "t5", name: "WebFetch", input: { url: p, prompt: p }, result: { content: p, isError: false }, ts: at(3) },
    { kind: "tool", toolUseId: "t6", name: `mcp__${p}__x`, input: { q: p }, result: { content: p, isError: false }, ts: at(3) },
    { kind: "plan", planId: "p", text: p, steps: [{ text: p, status: "pending" }], ts: at(4) },
    { kind: "question", requestId: "q", input: {}, card: { asker: { kind: "server", name: p }, mode: "question", questions: [{ id: "q", prompt: p, kind: "text" }] }, decision: "allow", answers: { q: p }, ts: at(4) },
    { kind: "error", message: p, ts: at(5) },
    { kind: "handoff", from: p, to: p, note: p, attempt: 1, ts: at(5) },
    { kind: "context_reset", note: p, reason: "declined", ts: at(5) },
  ] as Block[], {
    title: p, space: p, agent: p,
    images: { [`/tmp/${p}.png`]: png(100) },
    permissions: [{ requestId: "r", toolName: "Nothing", input: {}, title: p, decision: "deny", ts: at(5) }],
    children: {},
  });

  it("can put no script, handler, frame, form, style or remote URL into the page", () => {
    for (const p of payloads) {
      for (const options of [DEFAULT_SHARE_OPTIONS, { ...DEFAULT_SHARE_OPTIONS, thinking: true, hidePaths: false }]) {
        const doc = parse(buildSharePage(everywhere(p), options).html);
        const scripts = [...doc.querySelectorAll("script")];
        expect(scripts.map((s) => s.textContent), p).toEqual([PAGE_SCRIPT]);
        expect(doc.querySelectorAll("style"), p).toHaveLength(1);
        expect(doc.querySelectorAll("iframe, frame, object, embed, form, input:not([type=checkbox]), button:not(.theme), link, base, template, math, noscript"), p).toHaveLength(0);
        expect(doc.querySelectorAll("meta[http-equiv]"), p).toHaveLength(1);
        for (const el of doc.querySelectorAll("*")) {
          for (const a of el.getAttributeNames()) expect(a.startsWith("on") || a === "style" || a === "srcdoc" || a.includes(":"), `${p} → <${el.tagName} ${a}>`).toBe(false);
        }
        for (const el of doc.querySelectorAll("[href]")) {
          const href = el.getAttribute("href")!;
          expect(href.startsWith("#") || /^(https?|mailto):/.test(href), `${p} → ${href}`).toBe(true);
        }
        for (const img of doc.querySelectorAll("img")) expect(img.getAttribute("src"), p).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
        for (const svg of doc.querySelectorAll("svg")) expect(svg.matches(".chev, .made svg"), p).toBe(true);
      }
    }
  });

  it("shows the payload as the text it is", () => {
    const doc = parse(build(everywhere(`<img src=x onerror=alert(1)>`)).html);
    expect(doc.querySelector(".bubble")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(doc.querySelector(".msg-agent .md")?.textContent?.trim()).toBe("<img src=x onerror=alert(1)>");
    expect(doc.querySelector("h1")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("links only to the web and to mail", () => {
    expect(safeUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(safeUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "file:///etc/passwd", "./notes.md", "/Users/bob", "#top", "vbscript:x"]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
  });
});

describe("the page's policy", () => {
  it("allows its own script by hash, data: pictures, and nothing from the network", () => {
    const doc = parse(build(sample()).html);
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain(`script-src '${PAGE_SCRIPT_HASH}'`);
    expect(PAGE_SCRIPT_HASH).toBe(`sha256-${createHash("sha256").update(PAGE_SCRIPT).digest("base64")}`);
    // The script the page carries is exactly the one hashed.
    expect(doc.querySelector("script")?.textContent).toBe(PAGE_SCRIPT);
  });
});

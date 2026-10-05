import type { FakeScript } from "@realm/adapters";

/**
 * The scripted agent's drawn blocks (`contracts/ui-blocks.ts`), for `ui-blocks-live.mjs` and for
 * anyone developing the blocks offline: the fences only a real agent would otherwise write, and
 * nothing else can make the transcript draw.
 *
 * "draw the blocks" is one of each kind and one that does not parse, streamed a word at a time so a
 * fence can be watched staying code until it closes, then the same blocks written into a Markdown
 * document the reply names. "draw the other charts" covers the chart kinds the first leaves out, and
 * "draw a hostile diagram" is a diagram that asks Mermaid for everything strict mode and the gate
 * take away — a loose security level, a link, a callback, a picture from the network, a stylesheet.
 */

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

const BUNDLE = fence("realm-chart", `{
  "kind": "columns",
  "title": "Renderer bundle by release",
  "unit": "KB",
  "x": ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "2.0 b1", "2.0 b2", "2.0 b3"],
  "series": [
    { "label": "App code", "values": [612, 640, 655, 701, 722, 760, 781, 802, 815, 798] },
    { "label": "Libraries", "values": [1210, 1214, 1290, 1302, 1355, 1340, 1388, 1402, 1460, 1431] }
  ]
}`);

const SIGN_IN = fence("mermaid", `sequenceDiagram
  participant U as You
  participant R as Realm
  participant C as Claude CLI
  U->>R: Sign in with Claude
  R->>C: claude auth login
  C-->>U: Opens the consent page
  U->>C: Pastes the code
  C-->>R: Signed in
  R-->>U: Ready`);

const STORE = fence("realm-compare", `{
  "title": "Where the session store lives",
  "options": ["Postgres", "SQLite"],
  "pick": "SQLite",
  "rows": [
    { "label": "Setup", "values": ["A server to install and run", "A file beside the app"] },
    { "label": "Writers", "values": ["Many at once", "One at a time, in WAL mode"] },
    { "label": "Backups", "values": ["pg_dump on a schedule", "Copy the file"] },
    { "label": "Runs offline", "values": [false, true] }
  ]
}`);

/** Two values for three labels: the block stays code, saying so. */
const BROKEN = fence("realm-chart", `{
  "kind": "lines",
  "title": "Startup time",
  "unit": "ms",
  "x": ["1.4", "1.5", "1.6"],
  "series": [{ "label": "Cold", "values": [820, 790] }]
}`);

const DOCUMENT = `# Release notes, drawn

The bundle across the last ten releases:

${BUNDLE}

How a sign-in goes:

${SIGN_IN}

Where the session store lives:

${STORE}

A chart whose body does not parse stays code:

${BROKEN}
`;

export const FAKE_BLOCK_SCRIPT: FakeScript = [{
  on: "draw the blocks", emit: [
    { kind: "text", paceMs: 14, text: `Here is how the renderer bundle moved across the last ten releases:\n\n${BUNDLE}\n\n`
      + `The sign-in, end to end:\n\n${SIGN_IN}\n\nFor the session store, SQLite is the better fit:\n\n${STORE}\n\n`
      + `And startup time over the last three releases:\n\n${BROKEN}\n` },
    { kind: "tool", name: "Write", apply: true, result: "File created successfully at: notes/blocks.md", input: { file_path: "notes/blocks.md", content: DOCUMENT } },
    { kind: "text", text: "I put the same blocks in `notes/blocks.md`." },
  ],
}, {
  on: "draw the other charts", emit: [{ kind: "text", paceMs: 10, text: `Test time by suite:\n\n${fence("realm-chart", JSON.stringify({
    kind: "bars", title: "Test time by suite", unit: "s", x: ["Renderer", "Server", "Adapters", "Contracts", "UI"],
    series: [{ label: "Time", values: [184.2, 96.5, 41, 12.3, 8.7] }] }, null, 2))}\n\n`
    + `Startup, cold and warm — 1.5 was never measured cold:\n\n${fence("realm-chart", JSON.stringify({
      kind: "lines", title: "Startup time", unit: "ms", x: ["1.2", "1.3", "1.4", "1.5", "1.6", "2.0"],
      series: [{ label: "Cold", values: [910, 880, 820, null, 790, 745] }, { label: "Warm", values: [340, 322, 300, 291, 280, 262] }] }, null, 2))}\n\n`
    + `This week:\n\n${fence("realm-chart", JSON.stringify({
      kind: "sparkline", title: "This week",
      series: [{ label: "p95 latency (ms)", values: [212, 220, 198, 240, 205, 190, 186] }, { label: "Errors", values: [4, 2, 6, 3, 1, 0, 1] },
        { label: "Sessions", values: [38, 41, 45, 40, 52, 57, 61] }] }, null, 2))}\n\n`
    + `And how an event reaches the transcript:\n\n${fence("mermaid", `flowchart LR
  A[Agent CLI] -->|events| B(Adapter)
  B --> C{Session service}
  C -->|persist| D[(SQLite)]
  C -->|broadcast| E[Renderer]
  E --> F[Transcript]`)}\n` }],
}, {
  on: "draw a hostile diagram", emit: [{ kind: "text", text: `A diagram that asks for more than it gets:\n\n${fence("mermaid", `%%{init: {"securityLevel": "loose", "htmlLabels": true, "theme": "forest", "themeCSS": ".node rect { fill: url(https://example.com/fill.png) }"}}%%
flowchart TD
  A[Open the docs] --> B[Run the setup]
  B --> C@{ img: "https://example.com/logo.png", label: "Logo", pos: "t", w: 60, h: 60 }
  click A "https://example.com/docs" "Docs"
  click B call alert()
  style B fill:#f00,stroke:#333`)}\n` }],
}];

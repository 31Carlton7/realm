#!/usr/bin/env node
/**
 * A tiny MCP server over stdio that ships VIEWS (MCP Apps) — the fixture the views tests and the live
 * check connect as a Connection, standing in for a vendor whose tools draw their own UI.
 *
 *   show_chart      a bar chart of the values it is given, drawn by `ui://charts/bar.html`
 *   refresh_chart   the same chart with fresh numbers, for the VIEW to call — the agent never sees it
 *   probe_sandbox   a view that tries everything a view must not be able to do, and reports
 *   plain_sum       an ordinary tool with no view, for contrast
 *
 * The chart view speaks the bridge by hand, as the spec says a view may (no SDK): `ui/initialize`,
 * then `ui/notifications/initialized`, then it draws what `tool-input` and `tool-result` carry, and
 * reports its height. Its three buttons ask the host for the three things a view can ask for — a tool
 * call, a message to the agent, a link opened — each of which Realm holds for the user's click.
 *
 * Run with plain node from the repository: `node apps/server/src/mcp/fixtures/apps-stdio.mjs`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MIME = "text/html;profile=mcp-app";
const server = new Server({ name: "charts-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });

/** The bridge every view below opens with: requests, notifications, and the handshake. */
const BRIDGE = `
  let nextId = 0; const waiting = new Map(); const handlers = {};
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); post({ jsonrpc: "2.0", id, method, params }); });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); if (w) (m.error ? w.reject(m.error) : w.resolve(m.result)); return; }
    if (m.method === "ui/resource-teardown") { post({ jsonrpc: "2.0", id: m.id, result: {} }); return; }
    handlers[m.method]?.(m.params || {});
  });
  const theme = (ctx) => {
    const vars = ctx && ctx.styles && ctx.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
    if (ctx && ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
  };
  handlers["ui/notifications/host-context-changed"] = theme;
  const reportSize = () => notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.getBoundingClientRect().width), height: Math.ceil(document.body.getBoundingClientRect().height) });
  new ResizeObserver(reportSize).observe(document.body);
  let host = { capabilities: {}, context: {} };
  const connect = (name) => request("ui/initialize", { appInfo: { name, version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }, protocolVersion: "2026-01-26" })
    .then((r) => { host = { capabilities: r.hostCapabilities || {}, context: r.hostContext || {} }; theme(host.context); notify("ui/notifications/initialized", {}); return host; });
`;

const STYLE = `
  :root { color-scheme: light dark; font-family: var(--font-sans, -apple-system, system-ui, sans-serif); font-size: 13px; }
  body { margin: 0; padding: 16px 18px 18px; color: var(--color-text-primary, CanvasText); background: transparent; }
  h1 { font-size: 15px; font-weight: var(--font-weight-semibold, 600); margin: 0 0 2px; }
  .sub { margin: 0 0 16px; color: var(--color-text-secondary, GrayText); }
  button { font: inherit; padding: 6px 11px; border-radius: var(--border-radius-md, 8px); color: inherit; cursor: default;
    border: 1px solid var(--color-border-primary, rgba(128,128,128,.35)); background: var(--color-background-secondary, transparent); }
  button:disabled { opacity: .5; }
`;

const BAR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chart</title><style>${STYLE}
  .chart { display: grid; grid-template-columns: repeat(var(--n, 6), 1fr); gap: 10px; align-items: end; height: 150px; padding-top: 18px; }
  .bar { position: relative; border-radius: 5px 5px 2px 2px; background: var(--color-text-info, #3b82f6); min-height: 2px; transition: height .3s; }
  .bar b { position: absolute; top: -17px; left: -4px; right: -4px; text-align: center; font-weight: 500; font-size: 11px; font-variant-numeric: tabular-nums; }
  .axis { display: grid; grid-template-columns: repeat(var(--n, 6), 1fr); gap: 10px; margin-top: 6px; color: var(--color-text-secondary, GrayText); font-size: 11px; text-align: center; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .note { margin-top: 10px; color: var(--color-text-secondary, GrayText); font-size: 12px; min-height: 16px; }
</style></head><body>
  <h1 id="title">Loading…</h1><p class="sub" id="sub">Waiting for the host.</p>
  <div class="chart" id="chart"></div><div class="axis" id="axis"></div>
  <div class="actions">
    <button id="refresh">Refresh numbers</button>
    <button id="ask">Ask the agent about it</button>
    <button id="docs">Open the data source</button>
  </div>
  <p class="note" id="note"></p>
<script>
(() => {${BRIDGE}
  const $ = (id) => document.getElementById(id);
  let shown = { title: "", unit: "", labels: [], values: [] };
  const draw = (d) => {
    if (!d || !Array.isArray(d.values)) return;
    shown = { title: d.title || "Chart", unit: d.unit || "", labels: d.labels || d.values.map((_, i) => String(i + 1)), values: d.values };
    const max = Math.max(1, ...shown.values);
    $("title").textContent = shown.title;
    $("sub").textContent = shown.values.length + " values" + (shown.unit ? ", in " + shown.unit : "");
    document.documentElement.style.setProperty("--n", String(shown.values.length));
    $("chart").innerHTML = shown.values.map((v) => '<div class="bar" style="height:' + Math.round((v / max) * 100) + '%"><b>' + v + '</b></div>').join("");
    $("axis").innerHTML = shown.labels.map((l) => "<div>" + String(l).replace(/[<&]/g, "") + "</div>").join("");
  };
  handlers["ui/notifications/tool-input"] = (p) => draw(p.arguments);
  handlers["ui/notifications/tool-result"] = (r) => draw(r.structuredContent);
  const said = (t) => { $("note").textContent = t; };
  connect("Charts").then((h) => {
    if (!h.capabilities.serverTools) $("refresh").disabled = true;
    if (!h.capabilities.message) $("ask").disabled = true;
    if (!h.capabilities.openLinks) $("docs").disabled = true;
  });
  $("refresh").onclick = () => { said("Asking for fresh numbers…");
    request("tools/call", { name: "refresh_chart", arguments: { title: shown.title, labels: shown.labels } })
      .then((r) => { draw(r.structuredContent); said("Refreshed."); }, (e) => said("Not refreshed: " + (e && e.message || e))); };
  $("ask").onclick = () => request("ui/message", { role: "user", content: [{ type: "text", text: "Which release grew the most in " + shown.title + ", and why?" }] })
    .then(() => said("Sent to the prompter."), (e) => said("Not sent: " + (e && e.message || e)));
  $("docs").onclick = () => request("ui/open-link", { url: "https://example.com/releases/sizes" })
    .then(() => said("Opened."), (e) => said("Not opened: " + (e && e.message || e)));
})();
</script></body></html>`;

/**
 * Everything a view must not be able to do, tried. Each result is drawn in the view, and kept on
 * `window.__probe` for a live check attached to the frame to read.
 */
const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sandbox probe</title><style>${STYLE}
  table { border-collapse: collapse; width: 100%; } td { padding: 4px 6px; border-top: 1px solid var(--color-border-secondary, rgba(128,128,128,.2)); vertical-align: top; }
  td:first-child { width: 22px; } td:last-child { color: var(--color-text-secondary, GrayText); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
</style></head><body>
  <h1>Sandbox probe</h1><p class="sub">What this view could reach from inside its frame.</p>
  <table id="rows"></table>
<script>
(() => {${BRIDGE}
  const probe = window.__probe = { violations: [] };
  document.addEventListener("securitypolicyviolation", (e) => probe.violations.push({ uri: e.blockedURI, directive: e.effectiveDirective }));
  const attempt = (f) => { try { return "reached: " + String(f()); } catch (e) { return "blocked: " + e.name; } };
  probe.parentDom = attempt(() => window.parent.document.body.innerHTML.length);
  probe.parentRealm = attempt(() => typeof window.parent.realm);
  probe.ownRealm = typeof window.realm;
  probe.topDom = attempt(() => window.top.document.title);
  probe.siblings = Array.from({ length: window.parent.frames.length }, (_, i) => attempt(() => window.parent.frames[i] === window ? "self" : window.parent.frames[i].document.title));
  probe.cookie = attempt(() => { document.cookie = "probe=1; path=/"; document.cookie = "wide=1; domain=localhost; path=/"; return JSON.stringify(document.cookie); });
  probe.storage = attempt(() => { localStorage.setItem("probe", location.host); return localStorage.getItem("probe"); });
  probe.popup = attempt(() => String(window.open("https://example.com/popup")));
  probe.topNavigation = attempt(() => { window.top.location.href = "https://example.com/top"; return "no error"; });
  probe.origin = location.origin;
  const fetched = (url) => fetch(url, { mode: "no-cors" }).then(() => "answered", (e) => "failed: " + e.name);
  Promise.all([
    fetched("https://forbidden.realm-fixture.invalid/exfiltrate").then((r) => { probe.forbiddenFetch = r; }),
    fetched("https://allowed.realm-fixture.invalid/data").then((r) => { probe.allowedFetch = r; }),
    fetched("http://127.0.0.1:9/").then((r) => { probe.loopbackFetch = r; }),
  ]).then(() => new Promise((r) => setTimeout(r, 300))).then(() => {
    probe.done = true;
    const rows = [
      ["Realm's page", probe.parentDom], ["Realm's preload API", probe.parentRealm + " / own: " + probe.ownRealm],
      ["Other frames", probe.siblings.join(", ")], ["Cookies", probe.cookie], ["Its own storage", probe.storage],
      ["A popup", probe.popup], ["Top navigation", probe.topNavigation],
      ["An undeclared domain", probe.forbiddenFetch + " (" + probe.violations.filter((v) => v.uri.includes("forbidden")).length + " CSP report)"],
      ["Its declared domain", probe.allowedFetch + " (" + probe.violations.filter((v) => v.uri.includes("allowed")).length + " CSP report)"],
      ["127.0.0.1, declared", probe.loopbackFetch + " (" + probe.violations.filter((v) => v.uri.includes("127.0.0.1")).length + " CSP report)"],
    ];
    const ok = (label, v) => label === "Its declared domain" ? !v.includes("1 CSP") : label === "Its own storage" ? v.startsWith("reached") : !v.startsWith("reached") || v.includes('""') || v.includes("null");
    document.getElementById("rows").innerHTML = rows.map(([k, v]) => "<tr><td>" + (ok(k, v) ? "✓" : "✗") + "</td><td>" + k + "</td><td>" + String(v).replace(/[<&]/g, "") + "</td></tr>").join("");
  });
  connect("Sandbox probe");
})();
</script></body></html>`;

const TOOLS = [
  { name: "show_chart", description: "Chart a series of numbers as bars, in a view of its own.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, unit: { type: "string" }, labels: { type: "array", items: { type: "string" } }, values: { type: "array", items: { type: "number" } } }, required: ["values"] },
    _meta: { ui: { resourceUri: "ui://charts/bar.html" } } },
  { name: "refresh_chart", description: "Fresh numbers for a chart already on screen. Called by the chart's own view.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } } },
    _meta: { ui: { resourceUri: "ui://charts/bar.html", visibility: ["app"] } } },
  { name: "probe_sandbox", description: "Show a view that tests its own sandbox.", inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://charts/probe.html" } } },
  { name: "plain_sum", description: "Add numbers up. No view.", inputSchema: { type: "object", properties: { values: { type: "array", items: { type: "number" } } } } },
];

const RESOURCES = {
  "ui://charts/bar.html": { name: "Bar chart", text: BAR_HTML, ui: { prefersBorder: true } },
  "ui://charts/probe.html": { name: "Sandbox probe", text: PROBE_HTML, ui: { csp: {
    connectDomains: ["https://allowed.realm-fixture.invalid", "http://127.0.0.1:9", "https://localhost", "https://evil.example; script-src *"],
  } } },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: Object.entries(RESOURCES).map(([uri, r]) => ({ uri, name: r.name, mimeType: MIME })),
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const r = RESOURCES[request.params.uri];
  if (!r) throw new Error(`no resource ${request.params.uri}`);
  return { contents: [{ uri: request.params.uri, mimeType: MIME, text: r.text, _meta: { ui: r.ui } }] };
});

let refreshes = 0;
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const text = (t, structuredContent) => ({ content: [{ type: "text", text: t }], ...(structuredContent ? { structuredContent } : {}) });
  if (name === "show_chart") {
    const values = Array.isArray(args.values) ? args.values.map(Number) : [];
    const chart = { title: args.title ?? "Chart", unit: args.unit ?? "", labels: args.labels ?? values.map((_, i) => `#${i + 1}`), values };
    return text(`Charted ${values.length} values for “${chart.title}”: ${values.join(", ")}${chart.unit ? ` ${chart.unit}` : ""}.`, chart);
  }
  if (name === "refresh_chart") {
    refreshes += 1;
    const labels = Array.isArray(args.labels) && args.labels.length ? args.labels : ["a", "b", "c"];
    const values = labels.map((_, i) => 40 + ((i * 37 + refreshes * 53) % 90));
    return text(`Refreshed (${refreshes}).`, { title: args.title ?? "Chart", labels, values });
  }
  if (name === "probe_sandbox") return text("The probe view is open; it reports what it could reach.");
  if (name === "plain_sum") {
    const values = Array.isArray(args.values) ? args.values.map(Number) : [];
    return text(`The sum is ${values.reduce((a, b) => a + b, 0)}.`);
  }
  return { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
});

await server.connect(new StdioServerTransport());

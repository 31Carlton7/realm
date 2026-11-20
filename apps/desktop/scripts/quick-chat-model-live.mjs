/**
 * Live check: the Quick chat model setting, and the engine kept started for the next quick chat.
 *
 *   pnpm build && node apps/desktop/scripts/quick-chat-model-live.mjs            # captures, no turns
 *   LIVE_MEASURE=1 node apps/desktop/scripts/quick-chat-model-live.mjs           # BILLS: a tiny turn per run
 *   LIVE_WIRE=1 node apps/desktop/scripts/quick-chat-model-live.mjs              # the same runs, on a stand-in API
 *
 * Boots the built app quietly on a scratch home. The Claude CLI is the real one, signed in where it
 * always is (`~/.claude`, read in place); nothing is copied into the scratch home.
 *
 * Captures (default): the Settings row and a quick chat on the default model, light and dark, then a
 * pick in the row and a quick chat on that pick. Opening a quick chat sends nothing, so nothing bills.
 *
 * Measure (`LIVE_MEASURE=1`): quick chats, each asked one short question on the default model — the
 * first on a cold engine, the rest on the engine started when the one before was deleted. LIVE_RUNS
 * names them (default `cold,warm 1,warm 2`). Each run is split at the stages a person waits through:
 * the send, the engine's `init`, its first thinking, and its first streamed text. Every broadcast is
 * written to LIVE_OUT as it arrives, since the scratch home is gone when the app stops.
 *
 * Wire (`LIVE_WIRE=1`): the same runs, with the CLI pointed at a local stand-in for the Messages API
 * on a scratch config folder. Nothing bills. It records when each request left the CLI and what it
 * carried — the system prompt, the tools, the thinking and effort asked for — in `wire-requests.jsonl`.
 * With `LIVE_MEASURE=1` as well, the stand-in passes each request on to the real API under the
 * signed-in login, and also records when the answer's first byte, first thinking and first text came.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-quick-chat-model-live");
const WIRE = process.env.LIVE_WIRE === "1";
const BILLED = process.env.LIVE_MEASURE === "1";
const MEASURE = BILLED || WIRE;
const RUNS = (process.env.LIVE_RUNS ?? "cold,warm 1,warm 2").split(",");
fs.mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};

function rpc(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
  });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

// The fake agent stays registered in both modes: it is also what keeps the built server's titler and
// recap off the account (billed-calls.ts), so the measure's only billed calls are its three turns.
const requests = [];
const wire = WIRE ? await standInApi(path.join(OUT, "wire-requests.jsonl"), BILLED ? "https://api.anthropic.com" : null) : null;
const app = await launchLiveApp({ name: "quick-chat-model", env: wire?.env ?? {} });
const page = app.page;
const ev = (expr) => page.eval(expr);
const events = [];
const eventsFile = path.join(OUT, MEASURE ? "measure-events.jsonl" : "shots-events.jsonl");
fs.writeFileSync(eventsFile, "");
try {
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  const api = rpc(app.ports.server, await daemonToken(app.home), (event, payload) => {
    const row = { at: Date.now(), event, payload };
    events.push(row);
    fs.appendFileSync(eventsFile, `${js(row)}\n`);
  });
  await api.ready;
  const probe = await api.call("agents.probe", { force: false });
  const claude = probe.find((p) => p.kind === "claude");
  fs.writeFileSync(path.join(OUT, "probe-claude.json"), js({ available: claude?.available, loggedIn: claude?.loggedIn, version: claude?.version, models: claude?.models?.map((m) => m.id) }));

  const openQuickChat = async () => {
    await ev(`(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", metaKey: true, altKey: true, bubbles: true })); return true; })()`);
    await until(() => ev(`!!document.querySelector('.quick-chat .composer')`), 15_000, "the quick chat");
    return until(async () => (await api.call("settings.get", { key: "ui.quickChat" })).value?.sessionId, 10_000, "the quick chat's session");
  };
  const deleteQuickChat = async () => {
    await ev(`(() => { document.querySelector('.quick-chat [aria-label="Close quick chat"]').click(); return true; })()`);
    await sleep(150);
    await ev(`(() => { const b = document.querySelector('.quick-chat .quick-chat-confirm'); if (b) b.click(); return true; })()`);
    await until(() => ev(`!document.querySelector('.quick-chat')`), 10_000, "the quick chat closed");
  };
  const chip = () => ev(`document.querySelector('.quick-chat button[aria-label="Model"]')?.textContent ?? null`);

  if (MEASURE) {
    // The scratch config folder lists only the CLI's aliases, so the stand-in run names the model.
    if (WIRE && !BILLED) await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-haiku-5-5" } });
    const runs = [];
    for (const label of RUNS) {
      const id = await openQuickChat();
      const row = await api.call("sessions.get", { id });
      const t0 = Date.now();
      await api.call("sessions.send", { id, text: "Reply with the single word: ready" });
      const mine = (type) => events.find((e) => e.at >= t0 && e.event === "session.event" && e.payload.sessionId === id && type(e.payload.event.type));
      const first = await until(async () => mine((t) => t === "assistant_delta" || t === "assistant_text"), 90_000, `${label}: first token`);
      await until(async () => (await api.call("sessions.get", { id })).status === "idle", 90_000, `${label}: turn settled`);
      const init = mine((t) => t === "init");
      const thinking = mine((t) => t === "thinking");
      const asked = requests.find((r) => r.at >= t0 && r.url.startsWith("/v1/messages") && r.stream);
      const since = (e) => (e ? e.at - t0 : null);
      const run = { label, sessionId: id, model: row.model, effort: row.effort, ranModel: init?.payload.event.payload.model ?? null,
        tools: init?.payload.event.payload.tools.length ?? null,
        initMs: since(init), firstThinkingMs: since(thinking), firstTokenMs: since(first),
        ...(asked ? { requestMs: asked.at - t0, request: asked } : {}) };
      // The answer's own marks are written as it streams; read them once it has.
      if (asked?.answer) for (const [k, v] of Object.entries(asked.answer)) run[`api${k[0].toUpperCase()}${k.slice(1)}Ms`] = v === null ? null : v - t0;
      runs.push(run);
      fs.writeFileSync(path.join(OUT, "measure.json"), js(runs));
      console.log(`${label}: init ${run.initMs} ms, thinking ${run.firstThinkingMs ?? "none"}, first token ${run.firstTokenMs} ms on ${run.ranModel}`);
      await deleteQuickChat();
      // The spare's engine is started at the delete; give it the time a person takes to ask again.
      await sleep(8_000);
    }
    check("each quick chat is its own session", new Set(runs.map((r) => r.sessionId)).size === runs.length, runs.map((r) => r.sessionId));
    check("every quick chat ran Haiku", runs.every((r) => /haiku/.test(r.ranModel ?? "")), runs.map((r) => r.ranModel));
  } else {
    const stub = `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(${js(os.userInfo().username)}, "alex").replace(/Carlton( Aikins)?/g, "Alex Kim");
      const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`;
    const shot = async (name, sel, pad = 16) => {
      await ev(stub);
      await sleep(300);
      const box = sel ? await ev(`(() => { const r = document.querySelector(${js(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) : null;
      const { data } = await page.send("Page.captureScreenshot", { format: "png", ...(box ? { clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 1 } } : {}) });
      // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
      const flat = await ev(`(async () => { const img = new Image(); img.src = "data:image/png;base64," + ${js(data)}; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#808080"; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(flat, "base64"));
      console.log(`SHOT ${file}`);
    };
    // The store reads the theme at boot, so a change over RPC lands with a reload.
    const setMode = async (mode) => {
      await api.call("settings.set", { key: "ui.theme", value: mode });
      await page.send("Page.reload", {});
      await until(() => ev(`document.documentElement.dataset.mode === ${js(mode)} && !!document.querySelector('.composer')`), 20_000, `mode ${mode}`);
      await sleep(600);
    };
    const openSettings = async () => {
      await ev(`(() => { if (!document.querySelector('.settings-page-pane')) window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true })); return true; })()`);
      await until(() => ev(`!!document.querySelector('.settings-page-pane')`), 10_000, "Settings");
      await until(() => ev(`!!document.querySelector('[data-setting="quick-chat-model"] button[aria-label="Model"]')`), 10_000, "the Quick chat model row");
      await ev(`(() => { document.querySelector('[data-setting="quick-chat-model"]').scrollIntoView({ block: "center" }); return true; })()`);
    };
    const rowChip = () => ev(`document.querySelector('[data-setting="quick-chat-model"] button[aria-label="Model"]').textContent`);

    await until(async () => (await api.call("agents.probe", { force: false })).some((p) => p.kind === "claude" && p.models?.length), 30_000, "Claude's model list");
    await openSettings();
    check("the row shows Haiku by default", /Haiku/.test(await rowChip()), await rowChip());
    for (const mode of ["light", "dark"]) { await setMode(mode); await openSettings(); await shot(`settings-row-default-${mode}`, '[data-setting="quick-chat-model"]'); }

    const id = await openQuickChat();
    const row = await api.call("sessions.get", { id });
    check("a quick chat starts on Claude's Haiku", row.agentKind === "claude" && /haiku/.test(row.model ?? ""), { agentKind: row.agentKind, model: row.model });
    check("its picker says so", /Haiku/.test(await chip() ?? ""), await chip());
    for (const mode of ["light", "dark"]) {
      await setMode(mode);
      await until(() => ev(`!!document.querySelector('.quick-chat .composer')`), 15_000, "the quick chat, restored");
      await shot(`quick-chat-default-${mode}`, ".quick-chat", 24);
    }
    await deleteQuickChat();
    const spare = await until(async () => (await api.call("settings.get", { key: "quickChat.spare" })).value, 10_000, "the spare");
    check("deleting it leaves a spare started for the next", typeof spare === "string", spare);

    await openSettings();
    await ev(`(() => { document.querySelector('[data-setting="quick-chat-model"] button[aria-label="Model"]').click(); return true; })()`);
    await until(() => ev(`!!document.querySelector('[role="dialog"][aria-label="Model picker"]')`), 5_000, "the picker");
    await ev(`(() => { const o = [...document.querySelectorAll('[role="dialog"][aria-label="Model picker"] [role="option"]')].find((r) => /Sonnet 5\\.5/.test(r.textContent)); o.click(); return true; })()`);
    await until(async () => (await api.call("settings.get", { key: "quickChatModel" })).value?.model === "claude-sonnet-5-5", 5_000, "the pick stored");
    for (const mode of ["light", "dark"]) { await setMode(mode); await openSettings(); await shot(`settings-row-sonnet-${mode}`, '[data-setting="quick-chat-model"]'); }

    const id2 = await openQuickChat();
    const row2 = await api.call("sessions.get", { id: id2 });
    check("the next quick chat starts on the pick, not the Haiku spare", row2.model === "claude-sonnet-5-5" && id2 !== spare, { id: id2, spare, model: row2.model });
    check("its picker says Sonnet", /Sonnet/.test(await chip() ?? ""), await chip());
    for (const mode of ["light", "dark"]) {
      await setMode(mode);
      await until(() => ev(`!!document.querySelector('.quick-chat .composer')`), 15_000, "the quick chat, restored");
      await shot(`quick-chat-sonnet-${mode}`, ".quick-chat", 24);
    }
    await deleteQuickChat();
  }
  api.close();
} finally {
  await app.stop();
  wire?.close();
}

/**
 * A stand-in for the Messages API: each request is written down as it arrives. Alone, it answers
 * "ready" at once, and the CLI reaches it through a scratch config folder and a placeholder key, so
 * the signed-in login is neither used nor touched. Given `upstream`, it passes each request on with
 * the CLI's own headers and streams the answer back, noting when its first byte, thinking and text
 * came (`answer`), so a slow turn shows whether the time went before the API answered or inside it.
 */
async function standInApi(file, upstream) {
  fs.writeFileSync(file, "");
  const config = upstream ? null : fs.mkdtempSync(path.join(os.tmpdir(), "realm-quick-chat-wire-"));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let j = {};
      try { j = JSON.parse(body.toString()); } catch {}
      const system = Array.isArray(j.system) ? j.system.map((b) => b.text ?? "").join("") : String(j.system ?? "");
      const row = { at: Date.now(), url: req.url, model: j.model, stream: j.stream === true, thinking: j.thinking ?? null, outputConfig: j.output_config ?? null,
        systemChars: system.length, tools: (j.tools ?? []).length, toolsChars: js(j.tools ?? []).length, bytes: body.length };
      requests.push(row);
      fs.appendFileSync(file, `${js(row)}\n`);
      if (upstream) {
        row.answer = { firstByte: null, thinking: null, text: null, end: null };
        const headers = { ...req.headers };
        delete headers.host; delete headers["content-length"]; delete headers["accept-encoding"];
        const up = await fetch(upstream + req.url, { method: req.method, headers, body: req.method === "GET" ? undefined : body }).catch((e) => e);
        if (up instanceof Error) { res.writeHead(502); res.end(String(up)); return; }
        res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => k !== "content-encoding" && k !== "content-length")));
        for await (const chunk of up.body) {
          const text = Buffer.from(chunk).toString();
          const now = Date.now();
          row.answer.firstByte ??= now;
          if (row.answer.thinking === null && /"type":"thinking/.test(text)) row.answer.thinking = now;
          if (row.answer.text === null && /"text_delta"/.test(text)) row.answer.text = now;
          res.write(chunk);
        }
        row.answer.end = Date.now();
        res.end();
        fs.appendFileSync(file, `${js({ at: row.at, url: row.url, answer: row.answer })}\n`);
        return;
      }
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(js({ id: "msg_wire", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "ready" }], stop_reason: "end_turn", usage, input_tokens: 1 }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${js({ type, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_wire", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ready" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    env: upstream ? { ANTHROPIC_BASE_URL: base } : { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "stand-in", CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    close: () => { server.close(); if (config) fs.rmSync(config, { recursive: true, force: true }); },
  };
}

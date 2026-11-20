/**
 * Live check: the Quick chat model setting, and the engine kept started for the next quick chat.
 *
 *   pnpm build && node apps/desktop/scripts/quick-chat-model-live.mjs            # captures, no turns
 *   LIVE_MEASURE=1 node apps/desktop/scripts/quick-chat-model-live.mjs           # BILLS: three tiny turns
 *
 * Boots the built app quietly on a scratch home. The Claude CLI is the real one, signed in where it
 * always is (`~/.claude`, read in place); nothing is copied into the scratch home.
 *
 * Captures (default): the Settings row and a quick chat on the default model, light and dark, then a
 * pick in the row and a quick chat on that pick. Opening a quick chat sends nothing, so nothing bills.
 *
 * Measure (`LIVE_MEASURE=1`): three quick chats, each asked one short question on the default model —
 * the first on a cold engine, the next two on the engine started when the one before was deleted.
 * Time to first token is from the send to the first streamed text. Every broadcast is written to
 * LIVE_OUT as it arrives, since the scratch home is gone when the app stops.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-quick-chat-model-live");
const MEASURE = process.env.LIVE_MEASURE === "1";
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
const app = await launchLiveApp({ name: "quick-chat-model" });
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
    const runs = [];
    for (const label of ["cold", "warm 1", "warm 2"]) {
      const id = await openQuickChat();
      const row = await api.call("sessions.get", { id });
      const t0 = Date.now();
      await api.call("sessions.send", { id, text: "Reply with the single word: ready" });
      const first = await until(async () => events.find((e) => e.at >= t0 && e.event === "session.event" && e.payload.sessionId === id
        && (e.payload.event.type === "assistant_delta" || e.payload.event.type === "assistant_text")), 90_000, `${label}: first token`);
      await until(async () => (await api.call("sessions.get", { id })).status === "idle", 90_000, `${label}: turn settled`);
      const init = events.find((e) => e.event === "session.event" && e.payload.sessionId === id && e.payload.event.type === "init");
      const run = { label, sessionId: id, model: row.model, ranModel: init?.payload.event.payload.model ?? null, firstTokenMs: first.at - t0 };
      runs.push(run);
      fs.writeFileSync(path.join(OUT, "measure.json"), js(runs));
      console.log(`${label}: ${run.firstTokenMs} ms to first token on ${run.ranModel}`);
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
}

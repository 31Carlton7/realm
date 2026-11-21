/**
 * Live check: a meeting's live answers on the built app, with nothing billed.
 *
 *   pnpm build && node apps/desktop/scripts/live-answers-live.mjs
 *
 * Boots the built app quietly on a scratch home, with the calendar helper stood in for and the Claude
 * CLI pointed at a local stand-in for the Messages API on a scratch config folder, so the signed-in
 * login is neither used nor touched. No microphone, no system audio: the transcript is a fixture.
 *
 * Asks for answers over the app's own socket, as the panel will, and times each from the ask to its
 * first streamed piece: one cold, one after `meetings.prepareAnswers`, one on the engine started as the
 * last answer ended. Then a newer question while an answer streams, which must cancel it. Every
 * request the CLI made is written to `wire-requests.jsonl`, and the check reads them back for where
 * the transcript went: only to `/v1/messages`, only the window, and into no file in the scratch home.
 * It reads the parked engine's memory by pid, and checks Stop lets that engine go.
 *
 * Then it boots the app again under the rig's default env, which does not ask for the real engine
 * (`REALM_REAL_LIVE_ANSWERS`): the answer must be the scripted one, with no request to the stand-in and
 * no Claude Code process started.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-live-answers-live");
fs.mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + js(detail) : ""}`);
};

// A sales call, shaped as RealmVoice's continuous mode hands lines over. The opening is more than
// three minutes before the question, so it must not reach the model.
const T0 = Date.now();
const line = (source, text, start, end = start + 2_500) => ({ source, text, start, end, at: T0 + start });
const OPENING = "Thanks for making the time, this is the kickoff for the Halvorsen pilot.";
const lines = [
  line("them", OPENING, 0),
  line("me", "Happy to be here, we have the pricing ready.", 200_000),
  line("them", "We would want the annual plan if it has single sign on.", 205_000),
  line("them", "So how many seats would we need", 209_000),
  line("them", "for a team of twelve to start?", 211_600),
];
const customInfo = "I'm pitching the annual plan. Their CTO doubts the SSO story.";

const requests = [];
const wire = await standInApi(path.join(OUT, "wire-requests.jsonl"));
const calendar = noCalendar();
const app = await launchLiveApp({ name: "live-answers", env: { ...wire.env, ...calendar.env, REALM_REAL_LIVE_ANSWERS: "1" } });
const events = [];
const eventsFile = path.join(OUT, "events.jsonl");
fs.writeFileSync(eventsFile, "");
try {
  const api = await connect(app.ports.server, await daemonToken(app.home), (event, payload) => {
    if (event !== "meetings.answer") return;
    const row = { at: Date.now(), ...payload };
    events.push(row);
    fs.appendFileSync(eventsFile, `${js(row)}\n`);
  });
  await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-haiku-5-5" } });
  const of = (id) => events.filter((e) => e.answerId === id);
  const settled = (id) => of(id).some((e) => e.t === "done" || e.t === "error" || e.t === "cancelled");

  const runs = [];
  const measure = async (label, trigger) => {
    const t0 = Date.now();
    const { answerId } = await api.call("meetings.answer", { lines, customInfo, trigger });
    await until(async () => settled(answerId), 90_000, `${label}: the answer`);
    const mine = of(answerId);
    const first = mine.find((e) => e.t === "delta");
    const done = mine.find((e) => e.t === "done");
    const run = { label, answerId, firstTokenMs: first ? first.at - t0 : null, doneMs: done ? done.at - t0 : null, deltas: mine.filter((e) => e.t === "delta").length, steps: mine.map((e) => e.t), text: done?.text ?? null, error: mine.find((e) => e.t === "error")?.message ?? null };
    runs.push(run);
    fs.writeFileSync(path.join(OUT, "measure.json"), js(runs));
    console.log(`${label}: first token ${run.firstTokenMs} ms, done ${run.doneMs} ms, ${run.deltas} pieces`);
    return run;
  };

  await measure("cold", "key");
  // The answer before started the next engine as it ended; give it the time a call takes to move on.
  await sleep(8_000);
  await measure("warm after an answer", "question");
  await api.call("meetings.prepareAnswers", {});
  await sleep(8_000);
  const parked = claudeUnder(app.home);
  fs.writeFileSync(path.join(OUT, "spare.json"), js(parked));
  check("one Claude Code process parked for the next answer", parked.length === 1, parked);
  console.log(`parked spare: ${parked.map((p) => `${p.rssMB} MB resident, ${p.footprintMB ?? "?"} MB footprint`).join("; ")}`);
  await measure("warm after prepare", "question");
  await sleep(8_000);
  await measure("warm again", "key");

  for (const r of runs) check(`${r.label}: start, pieces, done`, r.steps[0] === "start" && r.steps.at(-1) === "done" && r.deltas >= 2, r.steps);

  // A newer question while an answer streams cancels it.
  await sleep(8_000);
  wire.slow(true);
  const first = (await api.call("meetings.answer", { lines, customInfo, trigger: "question" })).answerId;
  await until(async () => of(first).some((e) => e.t === "delta"), 60_000, "the first answer's first piece");
  const newer = [...lines, line("me", "Twelve to start, maybe twenty by spring.", 215_000), line("them", "And when could you start?", 220_000)];
  const second = (await api.call("meetings.answer", { lines: newer, customInfo, trigger: "question" })).answerId;
  await until(async () => settled(first) && settled(second), 90_000, "both answers settled");
  wire.slow(false);
  const firstSteps = of(first).map((e) => e.t);
  check("a newer question cancels the answer in flight", firstSteps.at(-1) === "cancelled" && !firstSteps.includes("done"), firstSteps);
  check("and is answered itself", of(second).at(-1)?.t === "done", of(second).map((e) => e.t));
  fs.writeFileSync(path.join(OUT, "cancel.json"), js({ first: of(first), second: of(second) }));

  // Where the words went.
  const carrying = requests.filter((r) => r.hasTranscript);
  check("the transcript went only to /v1/messages, once per answer", carrying.every((r) => r.url.startsWith("/v1/messages")) && carrying.length === runs.length + 2, carrying.map((r) => r.url));
  check("on the model the setting names", carrying.every((r) => r.model === "claude-haiku-5-5"), [...new Set(carrying.map((r) => r.model))]);
  check("with no tools, no thinking and low effort", carrying.every((r) => r.tools === 0 && r.thinking === null && r.effort === "low"), carrying.map((r) => ({ tools: r.tools, thinking: r.thinking, effort: r.effort })));
  check("and only the last three minutes", requests.every((r) => !r.hasOpening), requests.filter((r) => r.hasOpening).length);
  check("the custom info went with it", carrying.every((r) => r.hasCustomInfo));
  await sleep(8_000);
  check("an engine is parked again before Stop", claudeUnder(app.home).length === 1);
  await api.call("meetings.stopAnswers", {});
  await sleep(3_000);
  const afterStop = claudeUnder(app.home);
  check("Stop lets the parked engine go", afterStop.length === 0, afterStop);
  api.close();
  await sleep(500);
  const leftIn = grepTree(app.home, "for a team of twelve");
  check("no file in the scratch home holds the transcript", leftIn.length === 0, leftIn);
  const leftConfig = grepTree(wire.config, "for a team of twelve");
  check("no file in the CLI's config folder holds it", leftConfig.length === 0, leftConfig);
  fs.writeFileSync(path.join(OUT, "summary.json"), js({ runs: runs.map(({ label, firstTokenMs, doneMs, deltas }) => ({ label, firstTokenMs, doneMs, deltas })), requests: requests.length, carrying: carrying.length }));
} finally {
  await app.stop();
}

// The rig's default env: the scripted agent on, the real engine not asked for.
const before = requests.length;
const rig = await launchLiveApp({ name: "live-answers-rig", env: { ...wire.env, ...calendar.env } });
try {
  const seen = [];
  const api = await connect(rig.ports.server, await daemonToken(rig.home), (event, payload) => { if (event === "meetings.answer") seen.push(payload); });
  const answer = async () => {
    const { answerId } = await api.call("meetings.answer", { lines, customInfo, trigger: "key" });
    await until(async () => seen.some((e) => e.answerId === answerId && ["done", "error", "cancelled"].includes(e.t)), 30_000, "the scripted answer");
    return seen.filter((e) => e.answerId === answerId);
  };
  // A fresh scratch home with no Quick chat model setting: which agent the answer names.
  const unset = await answer();
  await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-haiku-5-5" } });
  const set = await answer();
  const processes = claudeUnder(rig.home);
  fs.writeFileSync(path.join(OUT, "rig-default.json"), js({ unset, set, requestsToStandIn: requests.length - before, claudeProcesses: processes }));
  console.log(`rig default, no setting: ${js(unset.map((e) => e.t === "start" ? `start ${e.model}` : e.t))}`);
  check("the rig's default env answers with the scripted model", set.at(-1)?.t === "done" && set.at(-1).text.startsWith("Scripted answer:"), set.map((e) => e.t));
  check("and sends no request to the stand-in", requests.length === before, requests.length - before);
  check("and starts no Claude Code process", processes.length === 0, processes);
  api.close();
} finally {
  await rig.stop();
  wire.close();
  calendar.remove();
}

/** The Claude Code processes the server on `home` started, by pid and name only: no command line is
 *  read, since a CLI's carries its session. */
function claudeUnder(home) {
  const server = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8")).pid;
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).trim().split("\n").map((l) => {
    const [pid, ppid, rss, ...comm] = l.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rssKB: Number(rss), name: path.basename(comm.join(" ")) };
  });
  const under = new Set([server]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!under.has(r.pid) && under.has(r.ppid)) { under.add(r.pid); grew = true; }
  }
  return rows.filter((r) => r.pid !== server && under.has(r.pid) && r.name === "claude").map((r) => ({ pid: r.pid, name: r.name, rssMB: Math.round(r.rssKB / 1024), footprintMB: footprintMB(r.pid) }));
}

function footprintMB(pid) {
  try {
    const m = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
    return m ? Math.round(Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]) : null;
  } catch { return null; }
}

function grepTree(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).size < 200_000_000 && fs.readFileSync(p).includes(needle)) hits.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

function connect(port, token, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
    else if (msg.event) onEvent(msg.event, msg.payload);
  });
  const call = (method, params) => new Promise((res, rej) => {
    const i = String(++id);
    pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return new Promise((res) => ws.addEventListener("open", () => res({ call, close: () => ws.close() })));
}

/**
 * A stand-in for the Messages API: each request is written down as it arrives, and a streamed one is
 * answered in four pieces, 30 ms apart (300 ms with `slow(true)`, so a newer question can land mid-answer).
 */
async function standInApi(file) {
  fs.writeFileSync(file, "");
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "realm-live-answers-wire-"));
  let gap = 30;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString();
      let j = {};
      try { j = JSON.parse(body); } catch {}
      const row = { at: Date.now(), url: req.url, model: j.model ?? null, stream: j.stream === true, thinking: j.thinking ?? null, effort: j.output_config?.effort ?? null, tools: (j.tools ?? []).length, bytes: body.length,
        hasTranscript: body.includes("for a team of twelve"), hasOpening: body.includes("Halvorsen"), hasCustomInfo: body.includes("doubts the SSO story") };
      requests.push(row);
      fs.appendFileSync(file, `${js(row)}\n`);
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(js({ id: "msg_wire", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "ready" }], stop_reason: "end_turn", usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${js({ type, ...data })}\n\n`);
      send("message_start", { message: { id: "msg_wire", type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, usage } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (const piece of ["Twelve seats ", "on the annual plan, ", "and SSO is ", "included."]) {
        await sleep(gap);
        if (res.destroyed) return;
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
      }
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
      send("message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "stand-in", CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    slow: (on) => { gap = on ? 300 : 30; },
    close: () => { server.closeAllConnections?.(); server.close(); fs.rmSync(config, { recursive: true, force: true }); },
  };
}

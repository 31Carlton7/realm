/**
 * Live end-to-end check for the Code Review page's server side: the BUILT server (dist/main.js, as
 * the app runs it — under Electron's node), over its real WebSocket, against a FAKE gh
 * (fixtures/fake-gh.mjs serving fixtures/code-review-fixture.mjs) and the scripted agent.
 *
 *   status / list / search / detail / files / patches / fileLines ──▶ the fake gh
 *   review ──▶ a plan-mode reviewer session ──▶ findings, anchored to the fixture's diff
 *   ask ──▶ a session with the request attached; the next question carries on in it
 *   submit ──▶ ONE POST, with exactly the payload composed
 *
 * Never GitHub. `REALM_GH_BIN` — the seam main.ts reads — names a shell wrapper that runs node on the
 * fake by absolute path, so neither PATH nor this Mac's own signed-in gh can be what answers; every
 * call it gets is logged and read back here, and a POST it was not expecting fails the check.
 *
 * Run:  pnpm build && node apps/server/scripts/live-code-review-check.mjs
 *
 * Hygiene: scratch REALM_HOME (removed at exit), never ~/Realm; the fake agent only
 * (REALM_ENABLE_FAKE_AGENT=1 also turns the titler and recap off, so nothing is billed); the server
 * is stopped by its own daemon.stop and then by its pid, and its port is checked free first.
 * Ports: LIVE_SERVER_PORT (8815).
 */
import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { buildFixture } from "./fixtures/code-review-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const ENTRY = join(repo, "apps/server/dist/main.js");
const ELECTRON = createRequire(join(repo, "apps/desktop/package.json"))("electron");
const FAKE_GH = join(here, "fixtures/fake-gh.mjs");
const PORT = Number(process.env.LIVE_SERVER_PORT ?? 8815);
const ref = { owner: "acme", repo: "widgets", number: 42 };
const wide = { owner: "acme", repo: "widgets", number: 38 };

let failures = 0;
const ok = (label, cond, detail = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) => execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN || true`, { encoding: "utf8" }).trim();

if (!existsSync(ENTRY)) { console.error(`no ${ENTRY} — run pnpm build first`); process.exit(1); }
if (listening(PORT)) { console.error(`port ${PORT} is in use — refusing to run`); process.exit(1); }

const home = mkdtempSync(join(tmpdir(), "realm-code-review-live-"));
const fixture = join(home, "gh-fixture.json");
const log = join(home, "gh-calls.jsonl");
writeFileSync(fixture, JSON.stringify(buildFixture()));
const gh = join(home, "gh");
writeFileSync(gh, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixture}' FAKE_GH_LOG='${log}' exec '${process.execPath}' '${FAKE_GH}' "$@"\n`);
chmodSync(gh, 0o755);
const ghCalls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const server = spawn(ELECTRON, [ENTRY], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REALM_HOME: home, REALM_PORT: String(PORT), REALM_GH_BIN: gh, REALM_ENABLE_FAKE_AGENT: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let errText = "";
server.stderr.on("data", (d) => { errText += d; });

async function main() {
  await new Promise((res, rej) => {
    let out = "";
    server.stdout.on("data", (d) => { out += d; if (/"type":"ready"/.test(out)) res(); if (/"type":"error"/.test(out)) rej(new Error(out)); });
    server.once("exit", (code) => rej(new Error(`server exited ${code}: ${errText.slice(-2000)}`)));
  });
  const { token } = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  const ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${PORT}`, [`realm.${token}`]); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map(); const events = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method, params) => new Promise((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.ok ? res(v.result) : rej(Object.assign(new Error(`${method}: ${v.error?.code} ${v.error?.message}`), { code: v.error?.code }))));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const events$ = (event) => events.filter((e) => e.event === event);
  const userText = async (sessionId) => (await call("sessions.events", { id: sessionId })).filter((e) => e.event.type === "user_message").map((e) => e.event.payload);
  const answers = async (sessionId) => (await call("sessions.events", { id: sessionId })).filter((e) => e.event.type === "assistant_text").map((e) => e.event.payload.text);

  try {
    const profile = await call("profiles.create", { name: "Live", icon: "home", color: "#7c6cff" });
    const space = await call("spaces.create", { profileId: profile.id, name: "Live", icon: "home" });

    console.log("1. gh, as the page first asks");
    const status = await call("codeReview.status", {});
    ok("signed in, as the fixture's account — through REALM_GH_BIN, the fake", status.state === "ready" && status.login === "carlton" && ghCalls().length === 1, JSON.stringify(status));

    console.log("\n2. the three lists, a page at a time");
    const authored = await call("codeReview.list", { section: "authored" });
    ok("Authored by me: the account's own requests, the draft included", authored.prs.map((p) => p.ref.number).join() === "39,38" && authored.prs[0].draft === true);
    const review = await call("codeReview.list", { section: "review" });
    ok("Needs my review: a page of ten, with a cursor to the rest", review.prs.length === 10 && review.nextCursor !== null && review.total === 13, `${review.prs.length} of ${review.total}`);
    const more = await call("codeReview.list", { section: "review", cursor: review.nextCursor });
    ok("Show more: the last three, and the end", more.prs.length === 3 && more.nextCursor === null);
    const team = await call("codeReview.list", { section: "team" });
    ok("Needs my team's review: the team's three", team.prs.length === 3);
    const before = ghCalls().length;
    await call("codeReview.list", { section: "review" });
    ok("a list read again inside its minute is the server's copy, not another gh call", ghCalls().length === before);
    const found = await call("codeReview.search", { query: "tokenizer" });
    ok("a search finds the request by its words", found.prs.some((p) => p.ref.number === 42));

    console.log("\n3. one request");
    const detail = await call("codeReview.detail", { ref });
    ok("its title, branches and head", detail.title === "Stream the tokenizer instead of buffering its input" && detail.base === "main" && detail.headSha.startsWith("9f2c4e1a"), detail.head);
    ok("its reviewers: carlton and the Core team still owed, jo-park's comment", JSON.stringify(detail.reviewers) === JSON.stringify([
      { name: "carlton", team: false, state: "pending" }, { name: "core", team: true, state: "pending" }, { name: "jo-park", team: false, state: "commented" }]));
    ok("its checks, merge state and conversation", detail.checks.map((c) => c.state).join() === "success,success,pending" && detail.mergeState === "blocked" && detail.comments.total === 2);

    console.log("\n4. its changes");
    const files = await call("codeReview.files", { ref, headSha: detail.headSha });
    const byPath = Object.fromEntries(files.files.map((f) => [f.path, f]));
    ok("seven files, every kind GitHub reports", files.total === 7 && byPath["src/legacy/buffer.ts"]?.status === "deleted" && byPath["test/tokenizer.test.ts"]?.status === "added");
    ok("a binary is a file with no lines to show, not an error", byPath["assets/logo.png"]?.patch === "none");
    const { patches } = await call("codeReview.patches", { ref, headSha: files.headSha, paths: ["src/tokenizer.ts", "src/parser.ts"] });
    const parser = patches.find((p) => p.path === "src/parser.ts");
    ok("patches parsed from git's own hunks, numbered as git numbered them",
      patches.length === 2 && parser?.hunks.length === 2 && parser.hunks[1].lines.some((l) => l.kind === "del" && l.oldLine === 31 && l.text.includes("UnterminatedString")));
    const { lines } = await call("codeReview.fileLines", { ref, headSha: files.headSha, path: "src/tokenizer.ts" });
    ok("the head's text, for opening an unchanged band", Array.isArray(lines) && lines.length === 37 && lines[13] === '    this.pending = "";', `${lines?.length} lines`);
    const wideDetail = await call("codeReview.detail", { ref: wide });
    const pagesBefore = ghCalls().filter((c) => (c.args[1] ?? "").includes("/pulls/38/files")).length;
    const wideFiles = await call("codeReview.files", { ref: wide, headSha: wideDetail.headSha });
    const pagesAsked = ghCalls().filter((c) => (c.args[1] ?? "").includes("/pulls/38/files")).length - pagesBefore;
    ok("a 360-file request is four pages of the files endpoint, every file listed", wideFiles.total === 360 && pagesAsked === 4, `${wideFiles.total} files over ${pagesAsked} pages`);

    console.log("\n5. Review with… (the scripted agent)");
    await call("codeReview.setInstructions", { profileId: profile.id, text: "Flag error paths that swallow a failure." });
    ok("the profile's instructions are kept as typed", (await call("codeReview.instructions", { profileId: profile.id })).text === "Flag error paths that swallow a failure.");
    const started = await call("codeReview.review", { ref, profileId: profile.id, spaceId: space.id, agentKind: "fake" });
    const reviewer = await call("sessions.get", { id: started.sessionId });
    ok("a reviewer session, read-only, from the review origin", reviewer.permissionMode === "plan" && reviewer.dispatchedBy?.kind === "review" && started.state === "running");
    let settled = null;
    for (let i = 0; i < 400 && !settled; i++) {
      settled = events$("codeReview.reviewChanged").find((e) => e.payload.review?.state !== "running")?.payload.review ?? null;
      if (!settled) await sleep(50);
    }
    ok("its findings land, on the wire", settled?.state === "done", settled?.state ?? "nothing");
    const where = (settled?.findings ?? []).map((f) => `${f.path}:${f.side}:${f.line}:${f.anchored}`).join(" ");
    ok("anchored to lines the diff shows — the head's 14, the base's 31 — and README's 400 kept off it",
      where === "src/tokenizer.ts:RIGHT:14:true src/parser.ts:LEFT:31:true README.md:RIGHT:400:false", where);
    const prompt = (await userText(started.sessionId))[0]?.text ?? "";
    ok("the reviewer was handed the instructions and the fenced diff", prompt.includes("Flag error paths that swallow a failure.") && prompt.includes("THE PULL REQUEST'S DIFF") && prompt.includes("+++ b/src/tokenizer.ts"));
    ok("…and nothing was posted by it", !ghCalls().some((c) => c.args.includes("POST")));

    console.log("\n6. Ask about this pull request");
    const asked = await call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text: "What does this change?" });
    let answered = false;
    for (let i = 0; i < 200 && !answered; i++) {
      answered = (await answers(asked.sessionId)).some((t) => t.includes("Tokenizer.feed"));
      if (!answered) await sleep(50);
    }
    const first = (await userText(asked.sessionId))[0];
    const context = first?.attachments?.[0]?.path ? readFileSync(first.attachments[0].path, "utf8") : "";
    ok("the question leads the message, the request rides attached", first?.text === "About pull request acme/widgets#42 (attached): What does this change?" && first.attachments.length === 1);
    ok("…its link, description and diff", context.includes("https://github.com/acme/widgets/pull/42") && context.includes("streams through") && context.includes("+++ b/src/parser.ts"));
    ok("…and an answer from the agent that read it", answered);
    const again = await call("codeReview.ask", { ref, spaceId: space.id, agentKind: "fake", text: "And the tests?" });
    ok("the next question carries on in the same session", again.sessionId === asked.sessionId);
    ok("the request remembers where its questions went", (await call("codeReview.thread", { ref })).sessionId === asked.sessionId);

    console.log("\n7. Submit review — the one write");
    const payload = { ref, headSha: files.headSha, event: "COMMENT", body: "Two things before this lands.",
      comments: [{ path: "src/tokenizer.ts", line: 14, side: "RIGHT", body: "Carry the partial token into the next feed." }] };
    const posted = await call("codeReview.submit", payload);
    ok("GitHub's answer comes back with the review's link", posted.url === "https://github.com/acme/widgets/pull/42#pullrequestreview-1001", JSON.stringify(posted));
    const posts = ghCalls().filter((c) => c.args.includes("POST"));
    ok("one POST, to the reviews endpoint", posts.length === 1 && posts[0].args.join(" ") === "api --method POST repos/acme/widgets/pulls/42/reviews --input -", posts[0]?.args.join(" "));
    ok("with exactly the payload composed", posts[0]?.stdin === JSON.stringify({ commit_id: files.headSha, event: "COMMENT", body: payload.body,
      comments: [{ path: "src/tokenizer.ts", line: 14, side: "RIGHT", body: "Carry the partial token into the next feed." }] }), posts[0]?.stdin ?? "");
    const refused = await call("codeReview.submit", { ...payload, body: "x", comments: [{ path: "README.md", line: 400, side: "RIGHT", body: "Off the diff." }] }).then(() => null, (e) => e.code);
    ok("a comment off the diff is refused before anything is sent", refused === "COMMENT_OFF_DIFF" && ghCalls().filter((c) => c.args.includes("POST")).length === 1, String(refused));
    await call("daemon.stop", {}).catch(() => {});
    ws.close();
  } catch (e) {
    ok("the check ran to the end", false, e instanceof Error ? e.message : String(e));
  }
}

const reap = () => {
  try { server.kill("SIGKILL"); } catch { /* gone */ }
  for (const pid of listening(PORT).split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
};
process.on("SIGINT", () => { reap(); process.exit(130); });
process.on("SIGTERM", () => { reap(); process.exit(143); });
try { await main(); } finally {
  await sleep(300);
  reap();
  rmSync(home, { recursive: true, force: true });
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

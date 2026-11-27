/**
 * Live check: an agent links a folder to its space and unlinks it, each behind the person's card.
 *
 *   pnpm build && LIVE_OUT=<dir> node apps/desktop/scripts/project-tools-live.mjs
 *
 * Boots the built app quietly on a scratch home with the scripted agent, on Ask each time. The agent's
 * `project_link` of a scratch folder raises a card (captured in light and dark); approved, the folder
 * is in the session's workspace selector (captured open, light and dark) and `project_list` names it.
 * Its `project_unlink` raises a card too; approved, `projects.list` no longer has it. A link of
 * `~/.ssh` is refused with no card. Every turn is a `sessions.send`, which is a turn the person started.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-project-tools-live");
fs.mkdirSync(OUT, { recursive: true });
const js = (v) => JSON.stringify(v);
const log = (name, value) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
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

const call = (on, tool, input = {}) => ({ on, emit: [{ kind: "call", tool: `realm-workspace__${tool}`, input, argsFromMessage: true }] });
const SCRIPT = [
  call("link the folder", "project_link"),
  call("list the projects", "project_list"),
  call("unlink the project", "project_unlink"),
];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-project-tools-"));
const scriptFile = path.join(scratch, "fake-script.json");
const folder = path.join(scratch, "stora-app");
fs.mkdirSync(folder);
fs.writeFileSync(scriptFile, js(SCRIPT));
const app = await launchLiveApp({ name: "project-tools", env: { REALM_FAKE_SCRIPT: scriptFile, REALM_HTML_MENUS: "1" } });
const page = app.page;
const ev = (expr) => page.eval(expr);
let api = null;
/** Each capture's `--page`, which a viewer needs under the pane's alpha: the PNGs keep it unflattened. */
const pages = {};
async function shoot(name) {
  for (const theme of ["light", "dark"]) {
    await api.call("settings.set", { key: "ui.theme", value: theme });
    await sleep(2500);
    const file = `${name}-${theme}.png`;
    await app.screenshot(path.join(OUT, file));
    pages[file] = await ev(`getComputedStyle(document.documentElement).getPropertyValue("--page").trim()`);
    console.log(`SCREENSHOT ${path.join(OUT, file)}`);
  }
}
try {
  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  await api.call("sessions.setOptions", { id: first.id, permissionMode: "default" });
  const spaceId = first.spaceId;

  let seen = 0;
  const events = async () => (await api.call("sessions.events", { id: first.id, afterSeq: 0, limit: 5000 })).map((e) => e.event);
  /** The first tool answer (or, with `card`, card) after the last one read. */
  const next = (what, card = false) => until(async () => {
    const all = await events();
    const hit = all.slice(seen).find((e) => e.type === (card ? "permission_request" : "tool_result"));
    if (hit && !card) seen = all.indexOf(hit) + 1;
    return hit ?? null;
  }, 30_000, what);
  const said = (r) => String(r.payload.content);

  // A folder that holds keys: refused before any card.
  await api.call("sessions.send", { id: first.id, text: `link the folder ${js({ path: "~/.ssh" })}` });
  const refused = await next("the ~/.ssh refusal");
  check("project_link refuses ~/.ssh with no card", refused.payload.isError && /keys and credentials/.test(said(refused)) && !(await events()).some((e) => e.type === "permission_request"), said(refused));

  await api.call("sessions.send", { id: first.id, text: `link the folder ${js({ path: folder })}` });
  const linkCard = await next("the link card", true);
  log("1-link-card", linkCard.payload);
  check("project_link asks first, naming the folder and the space", linkCard.payload.toolName === "project_link" && linkCard.payload.title.includes("stora-app"), linkCard.payload.title);
  await until(() => ev(`!!document.querySelector('.permission-card')`), 15_000, "the link card on screen");
  await shoot("link-card");
  await api.call("sessions.respondPermission", { id: first.id, requestId: linkCard.payload.requestId, decision: "allow" });
  const linked = await next("the link answer");
  log("2-link", linked.payload);
  const project = (await api.call("projects.list", { spaceId })).find((p) => p.name === "stora-app");
  check("approved, the folder is a project of the space", !linked.payload.isError && !!project, said(linked));

  await api.call("sessions.send", { id: first.id, text: "list the projects" });
  const listed = await next("the project list");
  log("3-list", said(listed));
  check("project_list names it with its id", said(listed).includes(`projectId ${project.id}`), said(listed));

  // A session's checkout is chosen before its first message, so the selector is a new session's.
  await ev(`(() => { document.querySelector('button[aria-label="New session"]').click(); return true; })()`);
  await until(() => ev(`!!document.querySelector('button[aria-label="Workspace"]')`), 15_000, "a new session's workspace selector");
  await ev(`(() => { document.querySelector('button[aria-label="Workspace"]').click(); return true; })()`);
  const menu = () => ev(`[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].map((m) => m.textContent.trim())`);
  const items = await until(async () => { const m = await menu(); return m.some((t) => t.includes("stora-app")) ? m : null; }, 15_000, "stora-app in the workspace selector");
  log("4-selector", items);
  check("the workspace selector offers the linked folder", items.some((t) => t.includes("stora-app")), items);
  await shoot("workspace-selector");
  await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
  // Back to the agent's session, where its next card is.
  await ev(`(() => { [...document.querySelectorAll('.sb-row .item-row')].find((r) => r.textContent.includes("link the folder")).click(); return true; })()`);

  await api.call("sessions.send", { id: first.id, text: `unlink the project ${js({ projectId: project.id })}` });
  const unlinkCard = await next("the unlink card", true);
  log("5-unlink-card", unlinkCard.payload);
  check("project_unlink asks first", unlinkCard.payload.toolName === "project_unlink" && unlinkCard.payload.title.includes("stora-app"), unlinkCard.payload.title);
  await until(() => ev(`!!document.querySelector('.permission-card')`), 15_000, "the unlink card on screen");
  await shoot("unlink-card");
  check("the project is still there while the card waits", (await api.call("projects.list", { spaceId })).some((p) => p.id === project.id));
  await api.call("sessions.respondPermission", { id: first.id, requestId: unlinkCard.payload.requestId, decision: "allow" });
  const unlinked = await next("the unlink answer");
  log("6-unlink", unlinked.payload);
  check("approved, the project is gone and the folder is not", !unlinked.payload.isError && !(await api.call("projects.list", { spaceId })).some((p) => p.id === project.id) && fs.existsSync(folder), said(unlinked));
  log("page-colours", pages);
} finally {
  api?.close();
  await app.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}

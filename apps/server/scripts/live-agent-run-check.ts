/**
 * Live end-to-end check for Plan 13 W1 — `agent_run`, driven by a REAL parent Claude session through
 * the REAL stack:
 *
 *   parent claude ── MCP gateway ──▶ realm-agent__agent_run (newWorktree)
 *      └─ creates a CHILD claude session in a FRESH git worktree (full toolset, default perms)
 *           └─ child claude writes a file THERE, reports; the parent's turn relays the fenced report
 *
 * Proves, against the real CLI:
 *   1. The parent's agent_run creates a real child session; the child's permissionMode is "default"
 *      even though the PARENT runs bypassPermissions (bypass never inherited), and the child's
 *      dispatch origin is recorded ({ parent id, "agent_run" }).
 *   2. The child runs INSIDE the new worktree and the requested file lands in the WORKTREE — and is
 *      absent from the space's primary checkout.
 *   3. The child's permission_requests surface on the CHILD's own session (auto-approved here, the
 *      way a user would on its pane), and the parent's tool result carries the fenced report.
 *   4. The child's gateway toolset is the full surface MINUS realm-agent (depth-1).
 *   5. Interrupt leg: a second run is cancelled by interrupting the PARENT — cancelled-wins, with
 *      whatever partial text existed.
 *
 * Run:  pnpm --filter @realm/server exec tsx scripts/live-agent-run-check.ts
 *
 * Hygiene: scratch REALM_HOME under mkdtemp (removed at exit); no real ~/Realm, no agent CLI config
 * touched; no ports beyond the app's own port-0 listeners. Requires claude installed + logged in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Session } from "@realm/contracts";
import type { McpServerConfig } from "@realm/adapters";
import { createApp, defaultAdapters } from "../src/app";
import { ProfilesStore } from "../src/store/profiles";
import { SpacesStore } from "../src/store/spaces";
import { McpCallLogStore } from "../src/store/mcp";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=live@example.com", "-c", "user.name=live", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "realm-agent-run-live-"));
  const app = await createApp({ home, port: 0, adapters: defaultAdapters() });
  console.log(`server up on :${app.port}\n`);

  const profile = new ProfilesStore(app.db).create({ name: "Live", icon: "home", color: "#7c6cff" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Live", icon: "home" });
  // The space folder becomes a real repository so newWorktree has something to branch.
  git(space.folderPath, "init", "-b", "main");
  writeFileSync(join(space.folderPath, "README.md"), "live check repo\n");
  git(space.folderPath, "add", "."); git(space.folderPath, "commit", "-m", "init");

  // Parent on bypass so its own MCP tool call runs unprompted — and so leg 1 can prove the child
  // did NOT inherit it.
  const parent = app.sessions.create({ spaceId: space.id, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions", title: "live parent" });
  const parentId = parent.session.id;

  // The user's stand-in: watch every agent_run child and answer its permission prompts on ITS pane.
  const answered: string[] = [];
  const childOf = (): Session | undefined => app.sessions.list(space.id).find((s) => s.dispatchedBy?.kind === "agent_run");
  const approver = setInterval(() => {
    for (const s of app.sessions.list(space.id)) {
      if (s.dispatchedBy?.kind !== "agent_run") continue;
      const evs = app.sessions.events(s.id, 0, 2000);
      const open = new Set<string>();
      for (const { event } of evs) {
        if (event.type === "permission_request") open.add(event.payload.requestId);
        if (event.type === "permission_response") open.delete(event.payload.requestId);
      }
      for (const requestId of open) {
        try { app.sessions.respondPermission(s.id, requestId, "allow"); answered.push(requestId); }
        catch { /* stale/raced */ }
      }
    }
  }, 500);

  console.log("— leg 1: parent Claude delegates a file-write into a fresh worktree —");
  const deadline = Date.now() + 480_000;
  await app.sessions.send(parentId, {
    text: [
      "Call the MCP tool realm-agent__agent_run exactly once, with:",
      '  goal: "Create a file named DELEGATED.txt containing exactly: hello from child\\nThen stop and report what you did."',
      '  constraints: { "newWorktree": "live-check" }',
      "Then reply with one line: RELAY: followed by the delegated agent's report status.",
    ].join("\n"),
    attachments: [],
  });
  while (Date.now() < deadline) {
    const s = app.sessions.get(parentId);
    if (s.status === "idle" && app.sessions.events(parentId, 0, 5000).some((e) => e.event.type === "assistant_text")) break;
    if (s.status === "error" || s.status === "ended") break;
    await sleep(500);
  }

  const child = childOf();
  ok("a child session exists with dispatchedBy = { parent, agent_run }", !!child && child.dispatchedBy?.sessionId === parentId, JSON.stringify(child?.dispatchedBy));
  ok("child permissionMode is default (parent runs bypass — never inherited)", child?.permissionMode === "default", child?.permissionMode);
  ok("child agentKind is claude", child?.agentKind === "claude", child?.agentKind);

  const worktree = child?.cwd ?? "";
  ok("child runs in a fresh worktree under the Realm home", worktree.includes(join(home, "worktrees", space.id)), worktree);
  const written = join(worktree, "DELEGATED.txt");
  ok("DELEGATED.txt exists in the WORKTREE", existsSync(written), written);
  if (existsSync(written)) ok("…with the requested content", readFileSync(written, "utf8").includes("hello from child"));
  ok("DELEGATED.txt absent from the PRIMARY checkout", !existsSync(join(space.folderPath, "DELEGATED.txt")));
  ok("the child's permission prompts surfaced on the child (answered there)", answered.length > 0, `${answered.length} answered`);

  const calls = new McpCallLogStore(app.db).list({ limit: 50 });
  const runCall = calls.find((c) => c.serverName === "realm-agent" && c.tool === "agent_run");
  ok("the gateway logged the agent_run call as ok", runCall?.ok === true, runCall?.resultSummary);
  ok("the tool result reported a finish", (runCall?.resultSummary ?? "").includes("Delegated agent finished"), runCall?.resultSummary);
  const parentText = app.sessions.events(parentId, 0, 5000).filter((e) => e.event.type === "assistant_text").at(-1);
  ok("the parent produced a final relay", parentText !== undefined && /RELAY/i.test((parentText.event.payload as { text: string }).text));

  if (child) {
    const cfg = app.gateway.register(child.id, space.id) as Extract<McpServerConfig, { url: string }>;
    const client = new Client({ name: "live", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    ok("child toolset excludes realm-agent (depth-1)", !names.some((n) => n.startsWith("realm-agent__")), names.filter((n) => n.startsWith("realm-agent__")).join(",") || "none");
    ok("child toolset keeps the normal surface (realm-browser present)", names.some((n) => n.startsWith("realm-browser__")), String(names.length));
  }

  console.log("\n— leg 2: interrupting the PARENT cancels the run —");
  const parent2 = app.sessions.create({ spaceId: space.id, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "bypassPermissions", title: "live parent 2" });
  const running = app.agentRuns.run({ sessionId: parent2.session.id, spaceId: space.id },
    { goal: "Count from 1 to 200, one number per message chunk, deliberately and slowly. Do not stop early." });
  const started = Date.now() + 120_000;
  let child2: Session | undefined;
  while (Date.now() < started) {
    child2 = app.sessions.list(space.id).find((s) => s.dispatchedBy?.kind === "agent_run" && s.id !== child?.id);
    if (child2 && app.sessions.get(child2.id).status === "running") break;
    await sleep(300);
  }
  ok("second child started running", !!child2 && app.sessions.get(child2.id).status === "running");
  await app.sessions.interrupt(parent2.session.id);
  const result = await running;
  const rtext = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
  ok("the run resolved as cancelled (cancelled-wins)", result.isError === true && rtext.includes("delegating session was interrupted"), rtext.slice(0, 120));
  if (child2) {
    const settledBy = Date.now() + 60_000;
    while (Date.now() < settledBy && app.sessions.get(child2.id).status !== "idle") await sleep(300);
    ok("the child was interrupted (idle, not still running)", app.sessions.get(child2.id).status === "idle", app.sessions.get(child2.id).status);
  }

  clearInterval(approver);
  await app.close();
  rmSync(home, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Live end-to-end check of the Realm agent stack against the REAL agent CLIs.
 *
 * Boots the actual server (`createApp` + `defaultAdapters`), creates a session per agent kind,
 * sends a real prompt, and asserts the normalized SessionEvent stream that SessionService persisted.
 * This exercises everything the unit tests stub out: process spawn, the real wire protocols, the
 * registry wiring (including whether each ACP kind got its own binary), and resume.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-agent-check.ts [kinds] [prompt]
 *   pnpm --filter @realm/server exec tsx scripts/live-agent-check.ts codex,acp:cursor
 *
 * Exits non-zero if any check fails. Requires the relevant CLIs to be installed and logged in.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveWorkspace } from "./live-workspace";
import type { AgentKind, SessionEvent } from "@realm/contracts";
import { createApp, defaultAdapters } from "../src/app";
import { ProfilesStore } from "../src/store/profiles";
import { SpacesStore } from "../src/store/spaces";

const KINDS = (process.argv[2] ?? "codex,acp:cursor").split(",").filter(Boolean) as AgentKind[];
const PROMPT = process.argv[3] ?? "Reply with exactly: REALM OK";
/**
 * Per-turn budget, applied to the resume leg too.
 *
 * It has to be this generous: `cursor-agent acp` sits silent for a fixed ~60s after `session/prompt` before it
 * streams a single chunk (reproducible with a bare JSON-RPC client, so it is the CLI, not Realm). The resume leg
 * used to get half this, which put the deadline within a few hundred milliseconds of when the answer actually
 * arrives — the turn was still in flight when the check gave up on it.
 */
const TURN_TIMEOUT_MS = 120_000;

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the persisted event log until the turn that begins at index `from` settles, and return that turn's slice.
 *
 * Scoped to `from` rather than to the whole log on purpose: `read()` hands back the session's entire history, and
 * on the resume leg that history already ends in the previous turn's `assistant_text` followed by `idle`. A
 * whole-history condition is therefore satisfiable before the new turn has produced anything at all.
 */
async function drain(read: () => SessionEvent[], from: number, timeoutMs: number): Promise<SessionEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evs = read().slice(from);
    const lastStatus = evs.filter((e) => e.type === "status").at(-1)?.payload.status;
    const settled = lastStatus === "idle" && evs.some((e) => e.type === "assistant_text");
    if (settled || lastStatus === "error" || lastStatus === "ended") return evs;
    if (Date.now() >= deadline) return evs;
    await sleep(200);
  }
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "realm-live-"));
  // A FIXED path, not a mkdtemp: codex records every cwd it starts a thread in as a trusted project in
  // the user's ~/.codex/config.toml and offers no way to opt out, so a per-run temp directory leaves a
  // dead entry behind on every run. See live-workspace.ts for the whole finding.
  const work = liveWorkspace();
  writeFileSync(join(work, "NOTES.txt"), "realm live check\n");

  const app = await createApp({ home, port: 0, adapters: defaultAdapters() });
  console.log(`server up on :${app.port}\n`);

  const probes = await app.sessions.probeAll();
  console.log("probes:");
  for (const p of probes) {
    console.log(`  ${p.kind.padEnd(12)} available=${String(p.available).padEnd(5)} version=${(p.version ?? "-").padEnd(24)} loggedIn=${p.loggedIn} ${p.reason ?? ""}`);
  }

  const profile = new ProfilesStore(app.db).create({ name: "Live", icon: "home", color: "#7c6cff" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Live", icon: "home" });

  for (const kind of KINDS) {
    console.log(`\n=== ${kind} ===`);
    const probe = probes.find((p) => p.kind === kind);
    if (!probe?.available) { ok("agent available", false, probe?.reason ?? "not registered"); continue; }

    const { session } = app.sessions.create({
      spaceId: space.id, agentKind: kind, projectId: null,
      model: null, effort: null, permissionMode: "bypassPermissions",
    });
    // Run in a scratch dir rather than the space folder so file tools have something harmless to touch.
    // cwd lives on the environment now, so move the environment rather than the session.
    app.db.prepare("UPDATE environments SET path = ? WHERE id = ?").run(work, session.environmentId);

    const read = () => app.sessions.events(session.id, 0, 1000).map((s) => s.event);

    const from = read().length;
    const t0 = Date.now();
    await app.sessions.send(session.id, { text: PROMPT, attachments: [] });
    const sendMs = Date.now() - t0;
    const evs = await drain(read, from, TURN_TIMEOUT_MS);

    const text = evs.filter((e) => e.type === "assistant_text").map((e) => (e.payload as { text: string }).text).join("");
    const errs = evs.filter((e) => e.type === "error").map((e) => (e.payload as { message: string }).message);
    const init = evs.find((e) => e.type === "init");
    const providerId = init ? (init.payload as { providerSessionId: string }).providerSessionId : null;
    const userMsgs = evs.filter((e) => e.type === "user_message").length;

    ok("send() returns on acceptance, not turn completion", sendMs < 20_000, `${sendMs}ms`);
    ok("init emitted with a providerSessionId", !!providerId, providerId ?? "none");
    ok("assistant text received", text.trim().length > 0, JSON.stringify(text.slice(0, 60)));
    ok("exactly one user_message (SessionService owns it)", userMsgs === 1, String(userMsgs));
    ok("no error events", errs.length === 0, errs.join(" | ").slice(0, 240));
    ok("session row ends idle", app.sessions.get(session.id).status === "idle", app.sessions.get(session.id).status);
    console.log(`  events: ${evs.map((e) => e.type).join(" ")}`);

    // Resume: drop the live handle the way a restart would, then send again.
    await app.sessions.closeAll();
    (app.sessions as unknown as { closing: boolean }).closing = false;
    app.sessions.markStaleOnBoot();

    const before = read().length;
    await app.sessions.send(session.id, { text: "Reply with exactly: RESUMED", attachments: [] });
    const after = await drain(read, before, TURN_TIMEOUT_MS);
    const init2 = after.find((e) => e.type === "init");
    const resumedId = init2 ? (init2.payload as { providerSessionId: string }).providerSessionId : null;
    const text2 = after.filter((e) => e.type === "assistant_text").map((e) => (e.payload as { text: string }).text).join("");

    ok("resume reuses the provider session id", !!resumedId && resumedId === providerId, `${resumedId} vs ${providerId}`);
    ok("resumed turn produced text", text2.trim().length > 0, JSON.stringify(text2.slice(0, 60)));
    ok("no duplicated history on resume", after.filter((e) => e.type === "user_message").length === 1,
      String(after.filter((e) => e.type === "user_message").length));
  }

  await app.close();
  rmSync(home, { recursive: true, force: true });
  // `work` is deliberately left on disk: removing it is what turns codex's trust entry into a dead one.
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("driver crashed:", e); process.exit(2); });

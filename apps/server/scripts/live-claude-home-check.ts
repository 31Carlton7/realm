/**
 * Live check of a profile's Claude config folder against the REAL `claude`.
 *
 * What no unit test can hold up is what a third-party binary does with one variable: that
 * `CLAUDE_CONFIG_DIR` really gives a `claude` process another sign-in, when Realm asks whether it is
 * signed in and when Realm starts a session.
 *
 * So this builds a scratch Realm home and an EMPTY scratch config folder, which is a folder nobody
 * has ever signed in to, and a profile that names it. Then, through the server's own code and the
 * real adapter:
 *
 *   1. The probe of that profile answers for that folder, and says signed out, whatever this Mac's
 *      default folder says.
 *   2. A session in that profile fails to authenticate, its fix names the folder, and Claude Code's
 *      own files appear in the scratch folder. A session that had run on the default sign-in would
 *      have spent tokens. This one spends none: what Claude Code says in the model's place is that
 *      nobody is logged in.
 *   3. A folder that is gone refuses the start, and nothing makes it again.
 *
 * No turn is billed: the only message is sent under a folder with no sign-in. The session step is
 * therefore skipped, and says so, when Realm's environment holds a credential that outranks every
 * folder (`claudeOverride`), because the message would run on that.
 *
 * It writes nothing outside its own temp folders. The default folder is asked whether it is signed
 * in, exactly as Realm's own probe asks, and the answer is printed without the account's name.
 *
 *   pnpm --filter @realm/server exec tsx scripts/live-claude-home-check.ts
 *
 * While `tsx` stops at the app's import of `@xterm/headless`, vite-node, which vitest brings, runs
 * it from `apps/server`. `VITE_NODE` is its folder under `node_modules/.pnpm`:
 *
 *   node ../../node_modules/.pnpm/VITE_NODE/node_modules/vite-node/vite-node.mjs scripts/live-claude-home-check.ts
 *
 * Exits non-zero if a check fails. Needs a `claude` Realm can run (its own copy counts).
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "@realm/adapters";
import type { SessionEvent } from "@realm/contracts";
import { createApp } from "../src/app";
import { ClaudeHomes, claudeOverride } from "../src/agents/claude-homes";
import { ProfilesStore } from "../src/store/profiles";
import { SettingsStore } from "../src/store/settings";
import { SpacesStore } from "../src/store/spaces";
import { finish, ok, sleep } from "./harness";

const TURN_TIMEOUT_MS = 120_000;
const MESSAGE = { text: "Reply with the single word ok.", attachments: [] };

async function main() {
  const home = mkdtempSync(join(tmpdir(), "realm-claude-home-live-"));
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "realm-claude-empty-")));
  const app = await createApp({ home, port: 0, userHome: homedir(), adapters: { claude: new ClaudeAdapter() } });
  console.log(`server up on :${app.port}\n`);
  try {
    const profiles = new ProfilesStore(app.db);
    const spaces = new SpacesStore(app.db, home);
    const homes = new ClaudeHomes({ settings: new SettingsStore(app.db), profiles, spaces });
    const usual = profiles.create({ name: "Usual", icon: "home", color: "#7c6cff" });
    const other = profiles.create({ name: "Other", icon: "home", color: "#7c6cff" });
    spaces.create({ profileId: usual.id, name: "Usual", icon: "home" });
    const space = spaces.create({ profileId: other.id, name: "Other", icon: "home" });
    const create = (): string => app.sessions.create({ spaceId: space.id, agentKind: "claude", projectId: null, model: null, effort: null, permissionMode: "default", title: "live" }).session.id;
    const eventsOf = (id: string): SessionEvent[] => app.sessions.events(id, 0, 2000).map((e) => e.event);

    console.log("== the probe, per folder ==");
    const named = homes.set(other.id, empty);
    ok("the profile names the scratch folder, and it is in force", named.dir === empty && named.inForce === empty && !named.missing);
    const mine = (await app.sessions.probe({ force: true })).find((r) => r.kind === "claude");
    ok("Realm can run a claude at all", mine?.available === true, mine?.reason ?? `version ${mine?.version ?? "?"}`);
    ok("the default folder's row says it is the default folder's", mine?.home === null,
      mine?.loggedIn === true ? "signed in" : mine?.loggedIn === false ? "signed out" : "cannot tell");
    const theirs = (await app.sessions.probe({ force: true, home: empty })).find((r) => r.kind === "claude");
    ok("the profile's row answers for the scratch folder", theirs?.home === empty);
    ok("a folder nobody signed in to reads as signed out", theirs?.loggedIn === false, theirs?.reason ?? "");
    ok("and carries nobody's account", theirs?.account === undefined);
    ok("asking about the scratch folder did not change the default folder's answer",
      (await app.sessions.probe()).find((r) => r.kind === "claude")?.loggedIn === mine?.loggedIn);

    console.log("\n== a session in that profile ==");
    const override = claudeOverride(process.env);
    if (override) {
      console.log(`  --    skipped: ${override} is set in this environment and outranks every folder's sign-in, so the message would run on it`);
    } else {
      const id = create();
      await app.sessions.send(id, MESSAGE);
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      const fixed = (): SessionEvent | undefined => eventsOf(id).find((e) => e.type === "error" && e.payload.fix);
      while (!fixed() && Date.now() < deadline) await sleep(500);
      const error = fixed();
      const spent = eventsOf(id).flatMap((e) => (e.type === "usage" ? [e.payload.inputTokens + e.payload.outputTokens + e.payload.costUsd] : []));
      ok("the turn spent nothing: it had no sign-in to spend with", spent.length > 0 && spent.every((n) => n === 0), `${spent.length} usage report(s)`);
      ok("it failed to authenticate", error?.type === "error" && error.payload.failure === "auth", error?.type === "error" ? error.payload.message : "no error with a fix arrived");
      ok("the fix names the folder to sign in to", error?.type === "error" && (error.payload.fix?.command ?? "").includes(`CLAUDE_CONFIG_DIR='${empty}'`),
        error?.type === "error" ? error.payload.fix?.command ?? "" : "");
      ok("the session reads as running under the scratch folder", app.sessions.claudeHome(id) === empty);
      const wrote = readdirSync(empty);
      ok("Claude Code kept its files in the scratch folder", wrote.length > 0, wrote.join(", "));
      await app.sessions.delete(id);
    }

    console.log("\n== a folder that has gone ==");
    rmSync(empty, { recursive: true, force: true });
    ok("the profile says its folder is missing", homes.get(other.id).missing);
    const gone = (await app.sessions.probe({ force: true, home: empty })).find((r) => r.kind === "claude");
    ok("the probe says so without asking Claude Code", gone?.loggedIn === false && (gone.reason ?? "").includes("is missing"), gone?.reason ?? "");
    let refused = "";
    try { await app.sessions.send(create(), MESSAGE); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    ok("a session there is refused before it starts", refused.includes("is missing"), refused);
    ok("and nothing made the folder again", !existsSync(empty));
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });

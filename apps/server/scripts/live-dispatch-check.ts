/**
 * Live end-to-end check for Plan 13 W2 — the ⌘⇧↩ dispatch gesture, driven through the REAL renderer
 * store (`createAppStore` + a ws-backed Api) against the REAL server and the REAL Claude CLI:
 *
 *   store.dispatchDraft(source) ──▶ sessions.create(userDispatched) + sessions.send(draft)
 *      └─ a real Claude session runs the draft in the space folder and writes a file
 *
 * Proves, against the real stack:
 *   1. One gesture: the dispatched session exists with `dispatchedBy: { kind: "user-dispatch" }`,
 *      inherits the composer's setup (agent kind, permission mode, environment), and the draft —
 *      the real prompt Claude runs — was sent to IT, not to the source session.
 *   2. Focus stays: `focusedLeafId` is byte-identical before and after, while the layout gained the
 *      new pane BESIDE the source (the openItemBesideQuiet path, on the real layout machinery).
 *   3. The draft cleared exactly as a send (no double-send ammunition left behind).
 *   4. Real work happened: Claude wrote DISPATCHED.txt in the space checkout.
 *   5. The settle produced a `session_done` notification row for the dispatched session.
 *
 * Run:  pnpm --filter @realm/server exec tsx scripts/live-dispatch-check.ts
 *
 * Hygiene: scratch REALM_HOME under mkdtemp (removed at exit); no real ~/Realm, no agent CLI config
 * touched; only the app's own port-0 listeners. Requires claude installed + logged in.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { allItems, type Session } from "@realm/contracts";
import { createApp, defaultAdapters } from "../src/app";
import { ProfilesStore } from "../src/store/profiles";
import { SpacesStore } from "../src/store/spaces";
import { createAppStore, type Api } from "../../desktop/src/renderer/src/state/store";
import { finish, ok, sleep } from "./harness";

/** A ws JSON-RPC client shaped like the renderer's — enough Api for boot + dispatch. */
async function wsApi(port: number): Promise<{ api: Api; close(): void }> {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.ok ? res(v.result) : rej(new Error(`${method}: ${v.error?.code} ${v.error?.message}`))));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const real: Partial<Api> = {
    listProfiles: () => call("profiles.list", {}),
    listSpaces: () => call("spaces.list", {}),
    listItems: (spaceId) => call("items.list", { spaceId }),
    listAllItems: () => call("items.listAll", {}),
    listProjects: (spaceId) => call("projects.list", { spaceId }),
    listEnvironments: (spaceId) => call("environments.list", { spaceId }),
    listSessions: (spaceId) => call("sessions.list", { spaceId }),
    listAllSessions: () => call("sessions.listAll", {}),
    getSession: (id) => call("sessions.get", { id }),
    createSession: (input) => call("sessions.create", input),
    sendMessage: async (id, text, attachments, mentions) => { await call("sessions.send", { id, text, attachments, mentions }); },
    sessionEvents: (id, afterSeq, limit) => call("sessions.events", { id, afterSeq, limit }),
    respondPermission: async (id, requestId, decision) => { await call("sessions.respondPermission", { id, requestId, decision }); },
    getSetting: async (key) => (await call("settings.get", { key })).value,
    setSetting: async (key, value) => { await call("settings.set", { key, value }); },
    setLayout: (id, layout) => call("spaces.setLayout", { id, layout }),
    listSkills: (spaceId) => call("skills.list", { spaceId }),
    listNotifications: (cursor, limit) => call("notifications.list", { cursor, ...(limit !== undefined ? { limit } : {}) }),
    machineName: async () => (await call("system.info", {})).machineName,
    gitInfo: (cwd) => call("workspace.gitInfo", { cwd }),
  };
  // Anything the flow was not expected to touch throws loudly instead of silently no-oping.
  const api = new Proxy(real, {
    get(t, prop: string) {
      if (prop in t) return (t as Record<string, unknown>)[prop];
      return () => { throw new Error(`live-dispatch-check: unexpected Api call ${String(prop)}`); };
    },
  }) as Api;
  return { api, close: () => ws.close() };
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "realm-dispatch-live-"));
  const app = await createApp({ home, port: 0, adapters: defaultAdapters() });
  console.log(`server up on :${app.port}\n`);
  const profile = new ProfilesStore(app.db).create({ name: "Live", icon: "home", color: "#7c6cff" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Live", icon: "home" });

  const { api, close } = await wsApi(app.port);
  const store = createAppStore(api);
  await store.getState().boot();

  // The composer the user is "typing in": a real (never-started) Claude session on bypass, so the
  // dispatched child inherits a mode that needs no prompt-answering for this file write.
  await store.getState().newSession({ agentKind: "claude", permissionMode: "bypassPermissions" });
  const source = Object.values(store.getState().sessions).find((s) => s.spaceId === space.id)!;
  const focusedBefore = store.getState().focusedLeafId;
  const openBefore = allItems(store.getState().layout!);

  const draft = "Create a file named DISPATCHED.txt containing exactly 'from-dispatch' in the current directory, then reply with one line saying done.";
  store.getState().setDraft(source.id, draft);

  console.log("— dispatch: one gesture, real Claude, focus stays put —");
  await store.getState().dispatchDraft(source.id);

  const st = store.getState();
  const child = app.sessions.list(space.id).find((s: Session) => s.dispatchedBy?.kind === "user-dispatch");
  ok("a dispatched session exists with the user-dispatch origin", !!child, child?.id ?? "none");
  ok("origin has no parent agent (sessionId null)", child?.dispatchedBy?.sessionId === null);
  ok("child inherits the composer's agent kind", child?.agentKind === "claude");
  ok("child inherits the composer's permission mode", child?.permissionMode === "bypassPermissions");
  ok("child inherits the composer's environment", child?.environmentId === source.environmentId);
  ok("the draft went to the CHILD (its transcript has it verbatim)",
    !!child && app.sessions.events(child.id, 0, 50).some((e) => e.event.type === "user_message" && (e.event.payload as { text: string }).text === draft));
  ok("the SOURCE session got nothing", app.sessions.events(source.id, 0, 50).length === 0);
  ok("the draft cleared (double-send mutant)", st.drafts[source.id] === "");
  ok("focus never moved", st.focusedLeafId === focusedBefore, `${focusedBefore} → ${st.focusedLeafId}`);
  const openAfter = allItems(st.layout!);
  const childItem = st.items.find((i) => i.kind === "session" && i.refId === child?.id);
  ok("the child's pane arrived BESIDE (layout gained it, source pane kept)",
    !!childItem && openAfter.includes(childItem.id) && openBefore.every((id) => openAfter.includes(id)));

  console.log("\n— the dispatched Claude actually works, and its settle notifies —");
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const s = child ? app.sessions.get(child.id) : null;
    if (s && s.status === "idle" && app.sessions.events(child!.id, 0, 500).some((e) => e.event.type === "assistant_text")) break;
    await sleep(1000);
  }
  const file = join(space.folderPath, "DISPATCHED.txt");
  ok("Claude wrote the file in the space checkout", existsSync(file), existsSync(file) ? readFileSync(file, "utf8").trim() : "missing");
  const feed = await api.listNotifications(null, 50);
  ok("a session_done notification row exists for the dispatched session",
    feed.notifications.some((nn) => nn.category === "session_done" && nn.sessionId === child?.id));

  close();
  await app.close();
  rmSync(home, { recursive: true, force: true });
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });

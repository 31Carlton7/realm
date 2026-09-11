import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { sessionEvent, NOTIFICATIONS_IMESSAGE_KEY, NOTIFICATIONS_SLACK_WEBHOOK_KEY, type Session } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { NotificationsStore } from "../store/notifications";
import { SettingsStore } from "../store/settings";
import { NotificationsService } from "./service";
import { NotificationRelay, relayText, type RelayTransport } from "./relay";
import type { RpcServer } from "../rpc/server";

let db: Db; let settings: SettingsStore; let svc: NotificationsService;
let sent: { via: "imessage" | "slack"; to: string; text: string }[]; let logs: string[];
let fail: Set<"imessage" | "slack">;

const session = (extra: Partial<Session> = {}): Session => ({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", spaceId: "01BX5ZZKBKACTAV9WEVGEMMVRZ", projectId: null, agentKind: "fake",
  model: null, effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", cwd: "/tmp",
  status: "running", providerSessionId: null, title: "Fix the login flow", lastEventSeq: 0, seenSeq: 0, terminalItemId: null,
  dispatchedBy: null, createdAt: 0, updatedAt: 0, ...extra,
});
const ask = (requestId: string) => sessionEvent("permission_request", { requestId, toolName: "Bash", input: {}, title: "Run ls", suggestions: [] });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = openDatabase(join(tempDir("realm-relay-"), "realm.db"));
  settings = new SettingsStore(db);
  sent = []; logs = []; fail = new Set();
  const transport: RelayTransport = {
    imessage: async (to, text) => { if (fail.has("imessage")) throw new Error("Messages is not signed in"); sent.push({ via: "imessage", to, text }); },
    slack: async (to, text) => { if (fail.has("slack")) throw new Error("slack webhook answered 404"); sent.push({ via: "slack", to, text }); },
  };
  const rpc = { broadcast: () => {} } as unknown as RpcServer;
  svc = new NotificationsService({ store: new NotificationsStore(db), settings, rpc,
    relay: new NotificationRelay({ settings, transport, log: (l) => logs.push(l) }) });
});

describe("relaying a notification beyond the machine", () => {
  it("sends nothing until a destination is configured", async () => {
    svc.handleSessionEvent(session(), ask("req-1"));
    await flush();
    expect(sent).toEqual([]);
  });

  it("texts the configured handle when an agent needs a permission, naming the session and the ask", async () => {
    settings.set(NOTIFICATIONS_IMESSAGE_KEY, "+15551234567");
    svc.handleSessionEvent(session(), ask("req-1"));
    await flush();
    expect(sent).toEqual([{ via: "imessage", to: "+15551234567", text: "Realm: Fix the login flow needs your OK — Run ls" }]);
  });

  it("posts to Slack too, and to both when both are set", async () => {
    settings.set(NOTIFICATIONS_IMESSAGE_KEY, "me@icloud.com");
    settings.set(NOTIFICATIONS_SLACK_WEBHOOK_KEY, "https://hooks.slack.com/services/T/B/x");
    svc.handleSessionEvent(session({ status: "running" }), sessionEvent("status", { status: "idle" }));
    await flush();
    expect(sent.map((s) => s.via).sort()).toEqual(["imessage", "slack"]);
    expect(sent[0]!.text).toBe("Realm: Fix the login flow finished — Finished a turn");
  });

  it("relays only what SURFACED: a repeat of a still-open permission is absorbed, not re-sent", async () => {
    /* The mutant: relay on every notify() call. One permission re-asked by a flapping harness
       would buzz a phone until it was muted, and a muted phone is the feature switched off. */
    settings.set(NOTIFICATIONS_IMESSAGE_KEY, "+15551234567");
    svc.handleSessionEvent(session(), ask("req-1"));
    svc.handleSessionEvent(session(), ask("req-1"));
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("never relays a category a person does not have to come back for", async () => {
    settings.set(NOTIFICATIONS_SLACK_WEBHOOK_KEY, "https://hooks.slack.com/services/T/B/x");
    svc.mcpServerStatus("m1", "linear", "error");
    await flush();
    expect(sent).toEqual([]);
  });

  it("a destination that is down is a log line, never a failure of the notification itself", async () => {
    settings.set(NOTIFICATIONS_IMESSAGE_KEY, "+15551234567");
    fail.add("imessage");
    expect(() => svc.handleSessionEvent(session(), ask("req-1"))).not.toThrow();
    await flush();
    expect(logs).toEqual(["[notifications] iMessage relay failed: Messages is not signed in"]);
    expect(svc.list({ cursor: null, limit: 10 }).notifications).toHaveLength(1);
  });

  it("reads the destination at send time, so a handle typed into Settings applies to the next notification", async () => {
    svc.handleSessionEvent(session(), ask("req-1"));
    settings.set(NOTIFICATIONS_IMESSAGE_KEY, "+15551234567");
    svc.handleSessionEvent(session(), ask("req-2"));
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("words each category the way a phone should read it", () => {
    expect(relayText({ category: "permission", title: "Deploy", body: "Run rm -rf build" })).toBe("Realm: Deploy needs your OK — Run rm -rf build");
    expect(relayText({ category: "session_done", title: "Deploy", body: null })).toBe("Realm: Deploy finished");
    expect(relayText({ category: "run_blocked", title: "Nightly", body: null })).toBe("Realm: Nightly is blocked");
  });
});

describe("relayText names where the work is", () => {
  it("carries the space, because at level C this line is all a person gets", () => {
    // MUTANT: drop the space and "Fix the login flow needs your OK" is a sentence you cannot act on
    // without going looking — with no window open anywhere, there is nothing else to look at.
    expect(relayText({ category: "permission", title: "Fix the login flow", body: null, spaceName: "Versed" }))
      .toBe("Realm: Fix the login flow (Versed) needs your OK");
  });

  it("says nothing about a space when there is none — a row about the app is not work in one", () => {
    expect(relayText({ category: "session_done", title: "Nightly sweep", body: null, spaceName: null }))
      .toBe("Realm: Nightly sweep finished");
    expect(relayText({ category: "session_done", title: "Nightly sweep", body: null }))
      .toBe("Realm: Nightly sweep finished");
  });
});

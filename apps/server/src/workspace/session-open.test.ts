import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { viewSettingKey, type Session } from "@realm/contracts";
import { createSessionOpenTools, capMode, type SessionOpenDeps } from "./session-open";
import type { SendMessage } from "../sessions/service";

/**
 * `session_open` over faked services. What matters: the user's card stands in front of it, the new
 * session is the user's (a pane beside the caller, never a delegated child), it never starts laxer
 * than the caller or the user's own default, and a delegated agent cannot open one.
 */

const SPACE = "space1", PROFILE = "prof1", ME = "sess-me";

const session = (extra: Partial<Session> = {}): Session => ({
  id: ME, spaceId: SPACE, projectId: "proj1", agentKind: "claude", model: "claude-opus-5-5", effort: null, fastMode: false, permissionMode: "default",
  environmentId: "env1", cwd: "/work", status: "running", providerSessionId: null, title: "The lead", lastEventSeq: 0, seenSeq: 0,
  terminalItemId: null, dispatchedBy: null, createdAt: 1, updatedAt: 1, ...extra,
} as Session);

type Opts = { caller?: Partial<Session>; allow?: boolean; userDefault?: string; child?: boolean; onScreen?: boolean; placeFails?: boolean };

function setup(o: Opts = {}) {
  const caller = session(o.caller);
  const calls = {
    gates: [] as { toolKey: string; title: string; input: Record<string, unknown> }[],
    created: [] as Parameters<SessionOpenDeps["sessions"]["create"]>[0][],
    sent: [] as { id: string; msg: SendMessage }[],
    broadcasts: [] as { event: string; payload: Record<string, unknown> }[],
    placed: [] as (string | undefined)[],
  };
  const view = { v: 1, zoomedLeafId: null, focusedItemId: "i-me", sidePanes: {}, layout: { type: "leaf", id: "l1", itemId: o.onScreen === false ? "i-other" : "i-me" } };
  const deps: SessionOpenDeps = {
    sessions: {
      get: () => caller,
      create: (input) => { calls.created.push(input); return { session: session({ id: "sess-new", ...input, title: input.title || "New session" } as Partial<Session>), itemId: "i-new" }; },
      send: async (id, msg) => { calls.sent.push({ id, msg }); },
    },
    items: { findByRefId: (refId) => (refId === ME ? { id: "i-me", spaceId: SPACE, kind: "session", title: "", sortOrder: 0, pinned: false, archived: false, refId, createdAt: 1, updatedAt: 1 } : null) },
    spaces: { get: () => ({ id: SPACE, profileId: PROFILE, name: "Live", icon: "", color: "#000000", sortOrder: 0, folderPath: "/s", groups: null, layout: null, activeItemId: null, createdAt: 1, updatedAt: 1 }) },
    settings: { get: (key) => (key === viewSettingKey(PROFILE) ? view : null) },
    broker: {
      gate: async (_sid, toolKey, title, input) => {
        calls.gates.push({ toolKey, title, input });
        return o.allow === false ? { allowed: false, reason: "the user denied this action" } : { allowed: true };
      },
    },
    rpc: { broadcast: (event: string, payload: Record<string, unknown>) => { calls.broadcasts.push({ event, payload }); } } as unknown as SessionOpenDeps["rpc"],
    defaultMode: () => o.userDefault ?? "default",
    placeModel: async (c, model) => {
      calls.placed.push(model);
      if (o.placeFails) return { ok: false, reason: "unknown", message: `refused: "${model}" names no model.` };
      return model === undefined
        ? { ok: true, choice: { kind: c.agentKind, model: c.model, label: "Claude Opus 5.5" } }
        : { ok: true, choice: { kind: "codex", model: "gpt-6", label: "GPT-6" } };
    },
    delegated: { isChild: () => o.child ?? false },
  };
  const group = createSessionOpenTools(deps);
  const call = (args: unknown = {}) => group.handlers.session_open!({ sessionId: ME, spaceId: SPACE }, args);
  return { group, call, calls };
}

const text = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text).join("\n");

describe("session_open", () => {
  it("asks first, then opens a session of the caller's agent beside it, attributed to the caller, and sends the prompt as the caller", async () => {
    const s = setup();
    const r = await s.call({ prompt: "echo hi\nand more", beside: "below" });
    expect(r.isError).toBe(false);
    expect(s.calls.gates).toEqual([{ toolKey: "session_open", title: expect.stringContaining('below this one: "echo hi and more"'), input: { prompt: "echo hi\nand more", beside: "below" } }]);
    expect(s.calls.created).toEqual([expect.objectContaining({
      spaceId: SPACE, agentKind: "claude", model: "claude-opus-5-5", environmentId: "env1", projectId: "proj1", title: "echo hi",
      dispatchedBy: { sessionId: ME, kind: "session_open" },
    })]);
    expect(s.calls.broadcasts).toEqual([{ event: "session.openRequested", payload: { spaceId: SPACE, sessionId: "sess-new", itemId: "i-new", openedBy: ME, edge: "bottom" } }]);
    expect(s.calls.sent).toEqual([{ id: "sess-new", msg: { text: "echo hi\nand more", attachments: [], from: { sessionId: ME, title: "The lead" } } }]);
    expect(text(r)).toContain("Opened session sess-new");
    expect(text(r)).toContain("in a pane below yours");
    expect(text(r)).toContain("will not report back to you");
  });

  it("opens on the right by default, sends nothing without a prompt, and says when the caller is not on screen", async () => {
    const s = setup({ onScreen: false });
    const r = await s.call({});
    expect(r.isError).toBe(false);
    expect(s.calls.broadcasts[0]!.payload.edge).toBe("right");
    expect(s.calls.sent).toEqual([]);
    expect(text(r)).toContain("It is empty, waiting for the user.");
    expect(text(r)).toContain("your session is not on screen");
  });

  it("opens nothing when the user says no", async () => {
    const s = setup({ allow: false });
    const r = await s.call({ prompt: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("the user denied this action");
    expect(s.calls.created).toEqual([]);
    expect(s.calls.broadcasts).toEqual([]);
  });

  it("refuses a delegated agent before asking anyone", async () => {
    const s = setup({ child: true });
    const r = await s.call({ prompt: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a delegated agent may not open sessions");
    expect(s.calls.gates).toEqual([]);
    expect(s.calls.created).toEqual([]);
  });

  it("resolves a named model to its harness, and refuses a name nobody knows before asking", async () => {
    const named = setup();
    await named.call({ model: "GPT-6" });
    expect(named.calls.placed).toEqual(["GPT-6"]);
    expect(named.calls.created[0]).toMatchObject({ agentKind: "codex", model: "gpt-6" });
    const unknown = setup({ placeFails: true });
    const r = await unknown.call({ model: "Nonesuch" });
    expect(text(r)).toContain('"Nonesuch" names no model');
    expect(unknown.calls.gates).toEqual([]);
  });

  it("starts no laxer than the caller, nor than the user's default for a new session", async () => {
    expect((await (async () => { const s = setup({ caller: { permissionMode: "bypassPermissions" }, userDefault: "default" }); await s.call({}); return s.calls.created[0]!.permissionMode; })())).toBe("default");
    expect((await (async () => { const s = setup({ caller: { permissionMode: "default" }, userDefault: "bypassPermissions" }); await s.call({}); return s.calls.created[0]!.permissionMode; })())).toBe("default");
    expect((await (async () => { const s = setup({ caller: { permissionMode: "bypassPermissions" }, userDefault: "bypassPermissions" }); await s.call({}); return s.calls.created[0]!.permissionMode; })())).toBe("bypassPermissions");
    expect(capMode("acceptEdits", "weird-adapter-mode")).toBe("weird-adapter-mode");
    expect(capMode("bypassPermissions", "weird-adapter-mode")).toBe("weird-adapter-mode");
  });

  it("describes itself as not delegation, and rejects arguments it does not know", async () => {
    const s = setup();
    expect(s.group.tools[0]!.description).toContain("It is NOT delegation");
    const r = await s.call({ prompt: "x", environmentId: "e" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("invalid arguments");
  });
});

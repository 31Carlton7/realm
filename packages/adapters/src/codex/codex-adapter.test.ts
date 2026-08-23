import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SessionEventOf, SessionEventType } from "@realm/contracts";
import { CodexAdapter, codexPolicyFor, pickCodexDecision } from "./codex-adapter";
import type { AgentHandle, StartOptions } from "../types";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const newAdapter = () => new CodexAdapter({ bin: process.execPath, args: [FAKE] });
const startOpts = (o: Partial<StartOptions> = {}): StartOptions => ({ cwd: process.cwd(), mcpServers: [], ...o });

/** Drains the handle's event stream into an array the assertions poll with `vi.waitFor`. */
function drain(h: AgentHandle) {
  const evs: SessionEvent[] = [];
  const done = (async () => { for await (const e of h.events) evs.push(e); })();
  return { evs, done };
}
const types = (evs: SessionEvent[]) => evs.map((e) => e.type);
const statuses = (evs: SessionEvent[]) => evs.filter((e) => e.type === "status").map((e) => e.payload.status);
const of = <T extends SessionEventType>(evs: SessionEvent[], t: T) => evs.filter((e) => e.type === t) as SessionEventOf<T>[];
const texts = (evs: SessionEvent[]) => of(evs, "assistant_text").map((e) => e.payload.text);

/** Boots a session and waits for `init`, the point after which every other call is meaningful. */
async function booted(o: Partial<StartOptions> = {}) {
  const adapter = newAdapter();
  const handle = adapter.start(startOpts(o));
  const { evs, done } = drain(handle);
  await vi.waitFor(() => expect(types(evs)).toContain("init"));
  return { adapter, handle, evs, done };
}

describe("pickCodexDecision", () => {
  // The live capture offered ["accept", {acceptWithExecpolicyAmendment:…}, "cancel"] — no "decline" at all.
  const LIVE = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: {} } }, "cancel"];

  it("maps deny to cancel when the server does not offer decline", () => {
    expect(pickCodexDecision("deny", LIVE)).toBe("cancel");
  });

  it("prefers decline over cancel when decline is offered", () => {
    expect(pickCodexDecision("deny", ["accept", "decline", "cancel"])).toBe("decline");
  });

  it("prefers acceptForSession for allow_always and falls back to accept", () => {
    expect(pickCodexDecision("allow_always", ["accept", "acceptForSession", "cancel"])).toBe("acceptForSession");
    expect(pickCodexDecision("allow_always", ["accept", "cancel"])).toBe("accept");
  });

  it("maps allow to accept", () => {
    expect(pickCodexDecision("allow", LIVE)).toBe("accept");
    expect(pickCodexDecision("allow", [])).toBe("accept");
  });

  it("never turns a deny into an accept, whatever is on offer", () => {
    expect(pickCodexDecision("deny", [])).toBe("cancel");
    expect(pickCodexDecision("deny", [{ applyNetworkPolicyAmendment: {} }])).toBe("cancel");
    expect(pickCodexDecision("deny", ["accept", "acceptForSession"])).toBe("cancel");
  });

  it("ignores non-string entries when matching", () => {
    expect(pickCodexDecision("allow_always", [{ acceptForSession: true }, "accept"])).toBe("accept");
  });
});

describe("codexPolicyFor", () => {
  it("maps plan to a read-only, untrusted thread", () => {
    expect(codexPolicyFor("plan")).toEqual({ approvalPolicy: "untrusted", sandbox: "read-only" });
  });
  it("maps bypassPermissions to never/danger-full-access", () => {
    expect(codexPolicyFor("bypassPermissions")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  it("maps everything else to on-request/workspace-write", () => {
    for (const m of ["default", "acceptEdits", undefined, "", "nonsense"]) {
      expect(codexPolicyFor(m)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    }
  });
});

describe("CodexAdapter", () => {
  it("is registered as the codex agent kind", () => {
    expect(newAdapter().kind).toBe("codex");
  });

  it("emits init then a full streaming turn, and never a user_message", async () => {
    const { adapter, handle, evs } = await booted();
    const init = of(evs, "init")[0]!;
    expect(init.payload.providerSessionId).toMatch(/^th_/);
    expect(init.payload.model).toBe("gpt-5.2");
    expect(init.payload.cwd).toBe(process.cwd());
    expect(init.payload.tools).toEqual([]);
    expect(statuses(evs)).toEqual(["idle"]);

    await handle.send({ text: "hi", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "usage")).toHaveLength(1));
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));

    expect(of(evs, "assistant_delta").map((e) => e.payload.delta)).toEqual(["hel", "lo"]);
    expect(texts(evs)).toEqual(["hello"]);
    expect(of(evs, "usage")[0]!.payload).toMatchObject({ inputTokens: 10, outputTokens: 2, numTurns: 1 });
    // SessionService emits user_message itself; a second one from the adapter would double every message.
    expect(types(evs)).not.toContain("user_message");
    expect(statuses(evs)).toEqual(["idle", "running", "running", "idle", "idle"]);
    await handle.dispose();
    expect(adapter.processCount).toBe(0);
  });

  it("emits init first even when a notification beat the thread/start response", async () => {
    const { handle, evs } = await booted({ model: "eager" });
    // attach() flushes the thread's buffer synchronously, so init has to be pushed before attaching or the
    // transcript opens with a status change out of nowhere.
    expect(types(evs)[0]).toBe("init");
    await vi.waitFor(() => expect(statuses(evs)).toEqual(["idle", "running"]));
    await handle.dispose();
  });

  it("accepts a send that arrives before the boot has finished", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts());
    const { evs } = drain(handle);
    await handle.send({ text: "hi", attachments: [] }); // no wait for init
    await vi.waitFor(() => expect(texts(evs)).toEqual(["hello"]));
    expect(types(evs).indexOf("init")).toBeLessThan(types(evs).indexOf("assistant_text"));
    await handle.dispose();
  });

  it("sends text with the mandatory text_elements and maps attachments", async () => {
    const { handle, evs } = await booted();
    await handle.send({
      text: "ECHO please",
      attachments: [{ path: "/tmp/shot.png", mime: "image/png" }, { path: "/tmp/notes.txt", mime: "text/plain" }],
    });
    await vi.waitFor(() => expect(texts(evs)).toHaveLength(1));
    const input = JSON.parse(texts(evs)[0]!) as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    // text_elements is a non-optional array in UserInput; omitting it is a deserialize error on the real server.
    expect(input[0]).toMatchObject({ type: "text", text_elements: [] });
    expect(input[0]!.text).toContain("ECHO please");
    expect(input[0]!.text).toContain("/tmp/notes.txt"); // non-images are appended to the text as a file list
    expect(input[0]!.text).not.toContain("/tmp/shot.png");
    expect(input[1]).toEqual({ type: "localImage", path: "/tmp/shot.png" });
    await handle.dispose();
  });

  it("sends only a text block when there are no attachments", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "ECHO", attachments: [] });
    await vi.waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect(JSON.parse(texts(evs)[0]!)).toEqual([{ type: "text", text: "ECHO", text_elements: [] }]);
    await handle.dispose();
  });

  it("maps Realm permission modes onto thread/start's approvalPolicy and sandbox", async () => {
    const cases = [
      ["plan", { approvalPolicy: "untrusted", sandbox: "read-only" }],
      ["bypassPermissions", { approvalPolicy: "never", sandbox: "danger-full-access" }],
      ["default", { approvalPolicy: "on-request", sandbox: "workspace-write" }],
    ] as const;
    for (const [permissionMode, expected] of cases) {
      const { handle, evs } = await booted({ permissionMode, model: "reflect" });
      // `sandbox` is the SandboxMode *string* on thread/start (the structured object is turn/start's `sandboxPolicy`).
      expect(JSON.parse(of(evs, "init")[0]!.payload.model)).toMatchObject({ ...expected, sessionStartSource: "startup", cwd: process.cwd() });
      await handle.dispose();
    }
  });

  it("omits model when unset and config when there are no mcp servers", async () => {
    const { handle, evs } = await booted({ model: "reflect" });
    const params = JSON.parse(of(evs, "init")[0]!.payload.model) as Record<string, unknown>;
    expect(params.config).toBeUndefined();
    const plain = await booted();
    expect(of(plain.evs, "init")[0]!.payload.model).toBe("gpt-5.2"); // fixture default: no model was sent
    await handle.dispose();
    await plain.handle.dispose();
  });

  it("passes mcp servers through config.mcp_servers", async () => {
    const { handle, evs } = await booted({
      model: "reflect",
      mcpServers: [{ name: "realm", command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: { A: "1" } }],
    });
    const params = JSON.parse(of(evs, "init")[0]!.payload.model) as { config: { mcp_servers: Record<string, unknown> } };
    expect(params.config.mcp_servers).toEqual({ realm: { command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: { A: "1" } } });
    await handle.dispose();
  });

  it("resumes an existing thread instead of starting a new one", async () => {
    const { handle, evs } = await booted({ resume: "th_previous", model: "reflect" });
    expect(of(evs, "init")[0]!.payload.providerSessionId).toBe("th_previous");
    const params = JSON.parse(of(evs, "init")[0]!.payload.model) as Record<string, unknown>;
    expect(params.threadId).toBe("th_previous");
    expect(params.sessionStartSource).toBeUndefined(); // thread/resume rejoins; it is not a new session start
    await handle.dispose();
  });

  it("rejoins a turn that was already running when the thread was resumed", async () => {
    const { handle, evs } = await booted({ resume: "th_busy" });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    // Nothing here ever called turn/start, so turn/started is the only place the turn id came from.
    await handle.interrupt();
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("interrupted");
    await handle.dispose();
  });

  it("bridges a fileChange approval as apply_patch with the itemId and grantRoot", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PATCH", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    const req = of(evs, "permission_request")[0]!.payload;
    expect(req.toolName).toBe("apply_patch");
    expect(req.input).toEqual({ itemId: of(evs, "tool_call")[0]!.payload.toolUseId, grantRoot: "/repo" });
    expect(req.title).toBe("Apply 1 edit to a.ts");
    expect(req.suggestions).toEqual(["accept", "acceptForSession", "decline", "cancel"]);

    handle.respondPermission(req.requestId, "allow");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "edit /repo/src/a.ts\n@@\n-old\n+new", isError: false });
    await handle.dispose();
  });

  it("denies a fileChange approval with decline, which this request does offer", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PATCH", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.isError).toBe(true);
    await handle.dispose();
  });

  it("bridges a command approval and produces the tool_result once allowed", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    expect(statuses(evs).at(-1)).toBe("waiting_permission");

    const req = of(evs, "permission_request")[0]!.payload;
    expect(req.toolName).toBe("exec_command");
    expect(req.input).toMatchObject({ command: "/bin/zsh -lc 'echo hi'", cwd: process.cwd() });
    expect(req.suggestions).toEqual(["accept", "cancel"]);
    expect(of(evs, "tool_call")[0]!.payload.name).toBe("exec_command");

    handle.respondPermission(req.requestId, "allow");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "permission_response")[0]!.payload).toEqual({ requestId: req.requestId, decision: "allow" });
    // exitCode 0 only happens if "accept" actually reached the child.
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "hi\n", isError: false });
    expect(statuses(evs)).toContain("waiting_permission");
    expect(statuses(evs).at(-1)).toBe("idle");
    await handle.dispose();
  });

  it("denies a command approval with a decision the server actually offers", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    // The fixture only accepts "accept"/"cancel"; a hard-coded "decline" would leave the turn wedged.
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ isError: true });
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("flips to waiting_permission only for the first open request, and back only after the last", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE2", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(2));
    expect(statuses(evs).filter((s) => s === "waiting_permission")).toHaveLength(1);

    const [first, second] = of(evs, "permission_request").map((e) => e.payload.requestId);
    const beforeAnswers = statuses(evs).length;
    handle.respondPermission(first!, "allow");
    await vi.waitFor(() => expect(of(evs, "permission_response")).toHaveLength(1));
    expect(statuses(evs)).toHaveLength(beforeAnswers); // one still open: status must not be restored yet

    handle.respondPermission(second!, "allow");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(2));
    expect(statuses(evs)[beforeAnswers]).toBe("running"); // restored exactly once, when the last one closed
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("answers an unknown server request with -32601 instead of stalling the turn", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ onLog: (l) => logs.push(l) });
    await handle.send({ text: "ODDBALL", attachments: [] });
    // The fixture only finishes the turn once its odd request is answered.
    await vi.waitFor(() => expect(texts(evs)).toEqual(["refused: -32601"]));
    expect(types(evs)).not.toContain("permission_request");
    expect(logs.some((l) => l.includes("item/tool/requestUserInput"))).toBe(true);
    await handle.dispose();
  });

  it("steers into a live turn rather than starting a second one", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.send({ text: "and also this", attachments: [] });
    await vi.waitFor(() => expect(texts(evs)).toEqual(["steered:and also this"]));
    await handle.dispose();
  });

  it("steers with the turn id from the turn/start response, before any notification arrives", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG SLOW", attachments: [] }); // notifications are 60ms behind the response
    await handle.send({ text: "immediately", attachments: [] });
    await vi.waitFor(() => expect(texts(evs)).toEqual(["steered:immediately"]));
    await handle.dispose();
  });

  it("falls back to turn/start when the turn ended between the check and the steer", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "GHOST", attachments: [] }); // opens a turn the server does not consider steerable
    await handle.send({ text: "second", attachments: [] });
    await vi.waitFor(() => expect(texts(evs)).toEqual(["hello"]));
    expect(texts(evs).some((t) => t.startsWith("steered:"))).toBe(false);
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("force-closes an open tool card on interrupt and returns to idle", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    expect(types(evs)).not.toContain("tool_result");

    await handle.interrupt();
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ toolUseId: of(evs, "tool_call")[0]!.payload.toolUseId, content: "interrupted", isError: true });
    expect(statuses(evs).at(-1)).toBe("idle");
    await handle.dispose();
  });

  it("denies pending permissions on interrupt", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.interrupt();
    expect(of(evs, "permission_response")[0]!.payload.decision).toBe("deny");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    await handle.dispose();
  });

  it("does not send turn/interrupt when no turn is live", async () => {
    const { handle, evs } = await booted();
    await handle.interrupt();
    await handle.interrupt();
    // A stray turn/interrupt would make the fixture emit idle + turn/completed.
    expect(statuses(evs)).toEqual(["idle"]);
    await handle.dispose();
  });

  it("does not interrupt a turn that already completed", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "hi", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "usage")).toHaveLength(1));
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    const before = statuses(evs).length;
    await handle.interrupt();
    await new Promise((r) => setTimeout(r, 40));
    expect(statuses(evs)).toHaveLength(before); // a stray turn/interrupt would add idle + turn/completed
    await handle.dispose();
  });

  it("records setOptions but reports that it only applies at the next thread start", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ onLog: (l) => logs.push(l) });
    await handle.setOptions({ model: "gpt-5.6-sol", permissionMode: "plan" });
    expect(logs.some((l) => l.includes("gpt-5.6-sol") && l.includes("plan"))).toBe(true);
    expect(types(evs)).not.toContain("error"); // it is a limitation, not a failure
    await handle.dispose();
  });

  it("turns a revoked login into an error naming `codex login`", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts({ model: "explode" }));
    const { evs, done } = drain(handle);
    await done;
    expect(of(evs, "error")[0]!.payload.message).toMatch(/codex login/);
    expect(of(evs, "error")[0]!.payload.message).toMatch(/failed to load configuration/);
    expect(statuses(evs)).toEqual(["error", "ended"]);
    expect(types(evs)).not.toContain("init");
    expect(adapter.processCount).toBe(0); // a failed boot must not pin the process forever
    await handle.dispose();
  });

  it("does not blame the login for a boot failure that is not a login problem", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts({ model: "nope" }));
    const { evs, done } = drain(handle);
    await done;
    const text = of(evs, "error")[0]!.payload.message;
    expect(text).toMatch(/unknown model/);
    // Telling someone to re-run `codex login` over a bad model name sends them down the wrong path entirely.
    expect(text).not.toMatch(/codex login/);
    expect(adapter.processCount).toBe(0);
  });

  it("reports a failed turn/start instead of leaving the session stuck on running", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "REFUSE", attachments: [] });
    await vi.waitFor(() => expect(statuses(evs)).toEqual(["idle", "running", "idle"]));
    expect(of(evs, "error")[0]!.payload.message).toMatch(/the model refused this turn/);
    await handle.dispose();
  });

  it("reports a steer failure that is not the stale-turn race instead of starting a second turn", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.send({ text: "BADSTEER", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "error")).toHaveLength(1));
    expect(of(evs, "error")[0]!.payload.message).toMatch(/internal error while steering/);
    // Retrying this as turn/start would silently run a SECOND concurrent turn against the same thread.
    expect(texts(evs)).toEqual([]);
    expect(of(evs, "tool_call")).toHaveLength(1);
    await handle.dispose();
  });

  it("reports a failed spawn as an error rather than hanging", async () => {
    const adapter = new CodexAdapter({ bin: "/definitely/not/a/codex/binary" });
    const handle = adapter.start(startOpts());
    const { evs, done } = drain(handle);
    await done;
    expect(of(evs, "error")).toHaveLength(1);
    expect(statuses(evs)).toEqual(["error", "ended"]);
    expect(adapter.processCount).toBe(0);
  });

  it("does not leave the refcount inflated when the process fails to start", async () => {
    const adapter = new CodexAdapter({ bin: "/definitely/not/a/codex/binary" });
    for (let i = 0; i < 2; i++) {
      const handle = adapter.start(startOpts());
      await drain(handle).done;
    }
    // A failed acquire that forgot to unwind would strand the count above zero and pin the next process,
    // and a cached rejected promise would leave `conn` set forever.
    expect(adapter.sessionCount).toBe(0);
    expect(adapter.processCount).toBe(0);
  });

  it("releases the process when a dispose races the boot", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts());
    const { evs, done } = drain(handle);
    await handle.dispose(); // before init has had any chance to land
    await done;
    expect(statuses(evs).at(-1)).toBe("ended");
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
  });

  it("shares one process across sessions and disposes it with the last one", async () => {
    const adapter = newAdapter();
    const one = adapter.start(startOpts());
    const two = adapter.start(startOpts());
    const a = drain(one);
    const b = drain(two);
    await vi.waitFor(() => {
      expect(types(a.evs)).toContain("init");
      expect(types(b.evs)).toContain("init");
    });
    expect(adapter.processCount).toBe(1);
    expect(of(a.evs, "init")[0]!.payload.providerSessionId).not.toBe(of(b.evs, "init")[0]!.payload.providerSessionId);

    await one.dispose();
    expect(adapter.processCount).toBe(1); // the surviving session still owns the process

    await two.send({ text: "hi", attachments: [] });
    await vi.waitFor(() => expect(texts(b.evs)).toEqual(["hello"]));
    expect(types(a.evs)).not.toContain("assistant_text"); // and the disposed one hears nothing

    const conn = (await adapter.connection)!;
    await two.dispose();
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
    expect(conn.alive).toBe(false);
  });

  it("detaches from the shared process so a disposed session stops being reachable", async () => {
    const adapter = newAdapter();
    const one = adapter.start(startOpts());
    const two = adapter.start(startOpts());
    const a = drain(one);
    const b = drain(two);
    await vi.waitFor(() => {
      expect(types(a.evs)).toContain("init");
      expect(types(b.evs)).toContain("init");
    });
    const conn = (await adapter.connection)!;
    expect(conn.threadCount).toBe(2);

    await one.dispose();
    // Without detach the listener, its mapper and the whole start() closure stay reachable from the
    // connection for the life of the process.
    expect(conn.threadCount).toBe(1);

    await two.dispose();
    expect(conn.threadCount).toBe(0);
    expect(conn.alive).toBe(false); // the refcount reaching zero has to actually kill the child
  });

  it("ends a still-attached session quietly when the shared process is deliberately torn down", async () => {
    const { adapter, evs, done } = await booted();
    const conn = (await adapter.connection)!;
    // onGone(reason, disposed: true) with a listener still attached: this is app quit. Reporting it would
    // spray "codex app-server exited" across every open Codex session.
    await conn.dispose();
    await done;
    expect(types(evs)).not.toContain("error");
    expect(statuses(evs)).toEqual(["idle", "ended"]);
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
  });

  it("ends quietly on a deliberate dispose", async () => {
    const { adapter, handle, evs, done } = await booted();
    await handle.dispose();
    await done;
    // onGone(reason, disposed: true) is us quitting; spraying "codex app-server exited" here would light up
    // every open Codex session on app quit.
    expect(types(evs)).not.toContain("error");
    expect(statuses(evs)).toEqual(["idle", "ended"]);
    expect(adapter.processCount).toBe(0);
  });

  it("is idempotent on dispose", async () => {
    const { adapter, handle, evs, done } = await booted();
    await handle.dispose();
    await handle.dispose();
    await done;
    expect(statuses(evs).filter((s) => s === "ended")).toHaveLength(1);
    expect(adapter.processCount).toBe(0);
  });

  it("closes open tool cards when the session is disposed mid-turn", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.dispose();
    await done;
    expect(of(evs, "tool_result")).toHaveLength(1);
    expect(of(evs, "tool_result")[0]!.payload.isError).toBe(true);
    expect(types(evs)).not.toContain("error");
  });

  it("reports an unexpected process death as an error and blames the crash on the open tool card", async () => {
    const { adapter, handle, evs, done } = await booted();
    await handle.send({ text: "CRASH", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await done;
    expect(of(evs, "error")).toHaveLength(1);
    expect(of(evs, "error")[0]!.payload.message).toMatch(/exited/);
    // "session closed" would be a lie here — the card has to say what actually happened to it.
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: expect.stringMatching(/exited/) as unknown as string, isError: true });
    expect(statuses(evs).slice(-2)).toEqual(["error", "ended"]);
    expect(adapter.processCount).toBe(0);
  });

  it("resolves a pending permission card when the session is disposed under it", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.dispose();
    await done;
    // An unanswered request leaves a dangling card in the UI and wedges that thread on a shared process.
    expect(of(evs, "permission_response")[0]!.payload).toMatchObject({ requestId: of(evs, "permission_request")[0]!.payload.requestId, decision: "deny" });
    expect(statuses(evs).at(-1)).toBe("ended");
  });

  it("fails a send once the session is gone instead of throwing at the caller", async () => {
    const { handle, evs } = await booted();
    await handle.dispose();
    await expect(handle.send({ text: "hi", attachments: [] })).resolves.toBeUndefined();
    expect(types(evs)).not.toContain("assistant_text");
  });
});

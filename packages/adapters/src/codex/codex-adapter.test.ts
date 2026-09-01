import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SessionEventOf, SessionEventType } from "@realm/contracts";
import { CodexAdapter, codexMcpConfig, codexPolicyFor, pickCodexDecision } from "./codex-adapter";
import type { AgentHandle, StartOptions } from "../types";

/**
 * Every assertion in this file is gated on a real child process: node cold start, module load and at least one
 * round trip. vitest's 1000 ms default is routinely too tight for that on a loaded two-core CI runner, and a
 * longer bound costs nothing when the assertion passes.
 */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000, interval: 25 });

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex-server.mjs", import.meta.url));
const newAdapter = (o: { bootTimeoutMs?: number } = {}) => new CodexAdapter({ bin: process.execPath, args: [FAKE], ...o });
const startOpts = (o: Partial<StartOptions> = {}): StartOptions => ({ cwd: process.cwd(), mcpServers: [], ...o });

/** Drains the handle's event stream into an array the assertions poll with `waitFor`. */
function drain(h: AgentHandle) {
  live.push(h);
  const evs: SessionEvent[] = [];
  const done = (async () => { for await (const e of h.events) evs.push(e); })();
  return { evs, done };
}

/** Every handle a test drained. A failing assertion skips the test's own dispose(); this stops that leaking a
 *  child process (and, with it, the shared app-server) into the rest of the run. */
const live: AgentHandle[] = [];
afterEach(async () => { for (const h of live.splice(0)) await h.dispose().catch(() => {}); });
const types = (evs: SessionEvent[]) => evs.map((e) => e.type);
const statuses = (evs: SessionEvent[]) => evs.filter((e) => e.type === "status").map((e) => e.payload.status);
const of = <T extends SessionEventType>(evs: SessionEvent[], t: T) => evs.filter((e) => e.type === t) as SessionEventOf<T>[];
const texts = (evs: SessionEvent[]) => of(evs, "assistant_text").map((e) => e.payload.text);

/** Boots a session and waits for `init`, the point after which every other call is meaningful. */
async function booted(o: Partial<StartOptions> = {}) {
  const adapter = newAdapter();
  const handle = adapter.start(startOpts(o));
  const { evs, done } = drain(handle);
  await waitFor(() => expect(types(evs)).toContain("init"));
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
    await waitFor(() => expect(of(evs, "usage")).toHaveLength(1));
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));

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
    await waitFor(() => expect(statuses(evs)).toEqual(["idle", "running"]));
    await handle.dispose();
  });

  it("accepts a send that arrives before the boot has finished", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts());
    const { evs } = drain(handle);
    await handle.send({ text: "hi", attachments: [] }); // no wait for init
    await waitFor(() => expect(texts(evs)).toEqual(["hello"]));
    expect(types(evs).indexOf("init")).toBeLessThan(types(evs).indexOf("assistant_text"));
    await handle.dispose();
  });

  it("sends text with the mandatory text_elements and maps attachments", async () => {
    const { handle, evs } = await booted();
    await handle.send({
      text: "ECHO please",
      attachments: [{ path: "/tmp/shot.png", mime: "image/png" }, { path: "/tmp/notes.txt", mime: "text/plain" }],
    });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
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

  it("attachment-only: an image-only send is just the localImage item — no empty text item (Plan 14 W5)", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "", attachments: [{ path: "/tmp/shot.png", mime: "image/png" }] });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect(JSON.parse(texts(evs)[0]!)).toEqual([{ type: "localImage", path: "/tmp/shot.png" }]);
    await handle.dispose();
  });

  it("attachment-only files: the file list stands alone, no leading blank lines (Plan 14 W5)", async () => {
    const { handle, evs } = await booted();
    // The path carries the ECHO trigger — the file list becomes the text item, which is the point.
    await handle.send({ text: "", attachments: [{ path: "/tmp/ECHO-notes.txt", mime: "text/plain" }] });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect(JSON.parse(texts(evs)[0]!)).toEqual([{ type: "text", text: "Attached files:\n- /tmp/ECHO-notes.txt", text_elements: [] }]);
    await handle.dispose();
  });

  it("sends only a text block when there are no attachments", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "ECHO", attachments: [] });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect(JSON.parse(texts(evs)[0]!)).toEqual([{ type: "text", text: "ECHO", text_elements: [] }]);
    await handle.dispose();
  });

  it("a resolved @-mention rides as Codex's NATIVE skill input item beside the text, never instead of it (W4)", async () => {
    const { handle, evs } = await booted();
    await handle.send({
      text: "ECHO use mac to list reminders",
      attachments: [{ path: "/tmp/shot.png", mime: "image/png" }],
      // name ≠ id on purpose: Codex knows the skill by its FRONTMATTER name (what skills/list reports),
      // so an item built from the directory id would name a skill that does not exist.
      skill: { id: "mac", name: "mac-skill", path: "/lib/skills/mac/SKILL.md" },
    });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect(JSON.parse(texts(evs)[0]!)).toEqual([
      { type: "text", text: "ECHO use mac to list reminders", text_elements: [] },
      { type: "skill", name: "mac-skill", path: "/lib/skills/mac/SKILL.md" },
      { type: "localImage", path: "/tmp/shot.png" },
    ]);
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
      mcpServers: [{ name: "realm", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: { A: "1" } }],
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
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    // Nothing here ever called turn/start, so turn/started is the only place the turn id came from.
    await handle.interrupt();
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("interrupted");
    await handle.dispose();
  });

  it("bridges a fileChange approval as apply_patch with the itemId and grantRoot", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PATCH", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    const req = of(evs, "permission_request")[0]!.payload;
    expect(req.toolName).toBe("apply_patch");
    expect(req.input).toEqual({ itemId: of(evs, "tool_call")[0]!.payload.toolUseId, grantRoot: "/repo" });
    expect(req.title).toBe("Apply 1 edit to a.ts");
    expect(req.suggestions).toEqual(["accept", "acceptForSession", "decline", "cancel"]);

    handle.respondPermission(req.requestId, "allow");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "edit /repo/src/a.ts\n@@\n-old\n+new", isError: false });
    await handle.dispose();
  });

  it("denies a fileChange approval with decline, which this request does offer", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PATCH", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.isError).toBe(true);
    await handle.dispose();
  });

  it("bridges a command approval and produces the tool_result once allowed", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    expect(statuses(evs).at(-1)).toBe("waiting_permission");

    const req = of(evs, "permission_request")[0]!.payload;
    expect(req.toolName).toBe("exec_command");
    expect(req.input).toMatchObject({ command: "/bin/zsh -lc 'echo hi'", cwd: process.cwd() });
    expect(req.suggestions).toEqual(["accept", "cancel"]);
    expect(of(evs, "tool_call")[0]!.payload.name).toBe("exec_command");

    handle.respondPermission(req.requestId, "allow");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
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
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    // The fixture only accepts "accept"/"cancel"; a hard-coded "decline" would leave the turn wedged.
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ isError: true });
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("flips to waiting_permission only for the first open request, and back only after the last", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE2", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(2));
    expect(statuses(evs).filter((s) => s === "waiting_permission")).toHaveLength(1);

    const [first, second] = of(evs, "permission_request").map((e) => e.payload.requestId);
    const beforeAnswers = statuses(evs).length;
    handle.respondPermission(first!, "allow");
    await waitFor(() => expect(of(evs, "permission_response")).toHaveLength(1));
    expect(statuses(evs)).toHaveLength(beforeAnswers); // one still open: status must not be restored yet

    handle.respondPermission(second!, "allow");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(2));
    expect(statuses(evs)[beforeAnswers]).toBe("running"); // restored exactly once, when the last one closed
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("answers an unknown server request with -32601 instead of stalling the turn", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ onLog: (l) => logs.push(l) });
    await handle.send({ text: "ODDBALL", attachments: [] });
    // The fixture only finishes the turn once its odd request is answered.
    await waitFor(() => expect(texts(evs)).toEqual(["refused: -32601"]));
    expect(types(evs)).not.toContain("permission_request");
    expect(logs.some((l) => l.includes("item/tool/requestUserInput"))).toBe(true);
    await handle.dispose();
  });

  it("steers into a live turn rather than starting a second one", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.send({ text: "and also this", attachments: [] });
    await waitFor(() => expect(texts(evs)).toEqual(["steered:and also this"]));
    await handle.dispose();
  });

  it("steers with the turn id from the turn/start response, before any notification arrives", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG SLOW", attachments: [] }); // notifications are 60ms behind the response
    await handle.send({ text: "immediately", attachments: [] });
    await waitFor(() => expect(texts(evs)).toEqual(["steered:immediately"]));
    await handle.dispose();
  });

  it("falls back to turn/start when the turn ended between the check and the steer", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "GHOST", attachments: [] }); // opens a turn the server does not consider steerable
    await handle.send({ text: "second", attachments: [] });
    await waitFor(() => expect(texts(evs)).toEqual(["hello"]));
    expect(texts(evs).some((t) => t.startsWith("steered:"))).toBe(false);
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    await handle.dispose();
  });

  it("force-closes an open tool card on interrupt and returns to idle", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    expect(types(evs)).not.toContain("tool_result");

    await handle.interrupt();
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ toolUseId: of(evs, "tool_call")[0]!.payload.toolUseId, content: "interrupted", isError: true });
    expect(statuses(evs).at(-1)).toBe("idle");
    await handle.dispose();
  });

  it("denies pending permissions on interrupt", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "APPROVE", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.interrupt();
    expect(of(evs, "permission_response")[0]!.payload.decision).toBe("deny");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
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
    const done = ["idle", "running", "running", "idle", "idle"];
    await waitFor(() => expect(statuses(evs)).toEqual(done));
    await handle.interrupt();
    // A positive signal rather than a sleep: run a second turn to completion. A stray turn/interrupt is
    // written to the child ahead of this turn's own frames, so anything it produced is already in `evs` by
    // the time the second answer lands — and the exact sequence below has no room for it.
    await handle.send({ text: "again", attachments: [] });
    await waitFor(() => expect(texts(evs)).toEqual(["hello", "hello"]));
    await waitFor(() => expect(statuses(evs)).toEqual([...done, "running", "running", "idle", "idle"]));
    await handle.dispose();
  });

  it("persists a half-streamed message when the turn is interrupted", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PARTIAL", attachments: [] });
    await waitFor(() => expect(of(evs, "assistant_delta")).toHaveLength(2));
    await handle.interrupt();
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    // assistant_delta is ephemeral: without the flush the streamed answer never reaches the transcript at all.
    expect(texts(evs)).toEqual(["half an answer"]);
    await handle.dispose();
  });

  it("persists a half-streamed message when the session is disposed mid-stream", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "PARTIAL", attachments: [] });
    await waitFor(() => expect(of(evs, "assistant_delta")).toHaveLength(2));
    await handle.dispose();
    await done;
    expect(texts(evs)).toEqual(["half an answer"]);
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
    await waitFor(() => expect(statuses(evs)).toEqual(["idle", "running", "idle"]));
    expect(of(evs, "error")[0]!.payload.message).toMatch(/the model refused this turn/);
    await handle.dispose();
  });

  it("reports a steer failure that is not the stale-turn race instead of starting a second turn", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "HANG", attachments: [] });
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.send({ text: "BADSTEER", attachments: [] });
    await waitFor(() => expect(of(evs, "error")).toHaveLength(1));
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
    await waitFor(() => {
      expect(types(a.evs)).toContain("init");
      expect(types(b.evs)).toContain("init");
    });
    expect(adapter.processCount).toBe(1);
    expect(of(a.evs, "init")[0]!.payload.providerSessionId).not.toBe(of(b.evs, "init")[0]!.payload.providerSessionId);

    await one.dispose();
    expect(adapter.processCount).toBe(1); // the surviving session still owns the process

    await two.send({ text: "hi", attachments: [] });
    await waitFor(() => expect(texts(b.evs)).toEqual(["hello"]));
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
    await waitFor(() => {
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
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.dispose();
    await done;
    expect(of(evs, "tool_result")).toHaveLength(1);
    expect(of(evs, "tool_result")[0]!.payload.isError).toBe(true);
    expect(types(evs)).not.toContain("error");
  });

  it("reports an unexpected process death as an error and blames the crash on the open tool card", async () => {
    const { adapter, handle, evs, done } = await booted();
    await handle.send({ text: "CRASH", attachments: [] });
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
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
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.dispose();
    await done;
    // An unanswered request leaves a dangling card in the UI and wedges that thread on a shared process.
    expect(of(evs, "permission_response")[0]!.payload).toMatchObject({ requestId: of(evs, "permission_request")[0]!.payload.requestId, decision: "deny" });
    expect(statuses(evs).at(-1)).toBe("ended");
  });

  it("bounds thread/start so a child that spawns and then answers nothing cannot hang the session", async () => {
    // No timeout here and boot stays pending forever: dispose() -> App.close() never returns and the desktop
    // main process SIGTERMs the server out from under its agent children.
    const adapter = newAdapter({ bootTimeoutMs: 200 });
    const handle = adapter.start(startOpts({ env: { FAKE_CODEX_MUTE_THREAD_START: "1" } }));
    const conn = adapter.connection!;
    const { evs, done } = drain(handle);
    // send() awaits boot too, so a bounded boot is what stops it hanging the WebSocket call as well.
    await expect(handle.send({ text: "hi", attachments: [] })).resolves.toBeUndefined();
    await done;
    expect(of(evs, "error")[0]!.payload.message).toMatch(/thread\/start within 200ms/);
    expect(statuses(evs)).toEqual(["error", "ended"]);
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
    expect((await conn).alive).toBe(false); // and the child it already spawned is gone with it
    await handle.dispose();
  });

  it("bounds thread/resume the same way", async () => {
    const adapter = newAdapter({ bootTimeoutMs: 200 });
    const handle = adapter.start(startOpts({ resume: "th_old", env: { FAKE_CODEX_MUTE_THREAD_START: "1" } }));
    const { evs, done } = drain(handle);
    await done;
    expect(of(evs, "error")[0]!.payload.message).toMatch(/thread\/resume within 200ms/);
    expect(adapter.processCount).toBe(0);
  });

  it("completes dispose even when the boot itself never settles", async () => {
    // The boot timeout is deliberately far longer than DISPOSE_TIMEOUT_MS here, so the only thing that can
    // resolve this dispose is the race in dispose() itself.
    const adapter = newAdapter({ bootTimeoutMs: 60_000 });
    const handle = adapter.start(startOpts({ env: { FAKE_CODEX_MUTE_THREAD_START: "1" } }));
    const conn = adapter.connection!;
    const { done } = drain(handle);
    const t0 = Date.now();
    await handle.dispose();
    expect(Date.now() - t0).toBeLessThan(10_000);
    await done;
    expect((await conn).alive).toBe(false); // the ref was handed back, so the shared process really died
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
  });

  it("hands the shared process back when the boot lands after dispose gave up waiting for it", async () => {
    // The window the dispose race opens: shutdown() runs before acquire() resolves, so the ref start() already
    // took is still outstanding when the process finally comes up — and nothing else will ever return it.
    const adapter = newAdapter({ bootTimeoutMs: 60_000 });
    const handle = adapter.start(startOpts({ env: { FAKE_CODEX_INITIALIZE_DELAY_MS: "3500" } }));
    const conn = adapter.connection!;
    const { done } = drain(handle);
    await handle.dispose();
    await done;
    await waitFor(() => expect(adapter.processCount).toBe(0));
    expect(adapter.sessionCount).toBe(0);
    expect((await conn).alive).toBe(false);
  });

  it("fails a send once the session is gone instead of throwing at the caller", async () => {
    const { handle, evs } = await booted();
    await handle.dispose();
    await expect(handle.send({ text: "hi", attachments: [] })).resolves.toBeUndefined();
    expect(types(evs)).not.toContain("assistant_text");
  });
});

/**
 * `skills/extraRoots/set` is per-CONNECTION, not per-thread, and CodexAdapter shares one connection across
 * every session — so these tests are as much about the union and the refcount as about the call itself.
 * The live counterpart (against the real 0.146.0 binary) is `apps/server/scripts/live-skills-check.ts`.
 */
describe("CodexAdapter skills", () => {
  const roots = async (adapter: CodexAdapter) =>
    (await (await adapter.connection!).request<{ extraRoots: string[] | null; calls: number }>("$test/extraRoots"));

  it("sets the session's skills root on the connection once the thread exists", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts({ skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" } }));
    const { evs } = drain(handle);
    await waitFor(() => expect(types(evs)).toContain("init"));
    await waitFor(async () => expect((await roots(adapter)).extraRoots).toEqual(["/tmp/realm-plugin/skills"]));
  });

  it("never calls it at all for a session with no skills", async () => {
    const { adapter, evs } = await booted();
    expect(types(evs)).toContain("init");
    expect((await roots(adapter)).calls).toBe(0);
    expect(adapter.extraRootCount).toBe(0);
  });

  it("unions the roots of every live session and drops each one as its session ends", async () => {
    const adapter = newAdapter();
    const a = adapter.start(startOpts({ skills: { pluginPath: "/tmp/a", root: "/tmp/a/skills" } }));
    const evsA = drain(a).evs;
    await waitFor(() => expect(types(evsA)).toContain("init"));
    const b = adapter.start(startOpts({ skills: { pluginPath: "/tmp/b", root: "/tmp/b/skills" } }));
    const evsB = drain(b).evs;
    await waitFor(() => expect(types(evsB)).toContain("init"));
    await waitFor(async () => expect((await roots(adapter)).extraRoots).toEqual(["/tmp/a/skills", "/tmp/b/skills"]));
    // One session ending must not take the other's skills away with it.
    await b.dispose();
    await waitFor(async () => expect((await roots(adapter)).extraRoots).toEqual(["/tmp/a/skills"]));
    expect(adapter.extraRootCount).toBe(1);
  });

  it("counts two sessions sharing one root and only drops it when the last of them goes", async () => {
    const adapter = newAdapter();
    const skills = { pluginPath: "/tmp/same", root: "/tmp/same/skills" };
    const a = adapter.start(startOpts({ skills }));
    const evsA = drain(a).evs;
    await waitFor(() => expect(types(evsA)).toContain("init"));
    const b = adapter.start(startOpts({ skills }));
    const evsB = drain(b).evs;
    await waitFor(() => expect(types(evsB)).toContain("init"));
    expect(adapter.extraRootCount).toBe(1);
    await b.dispose();
    await waitFor(async () => expect((await roots(adapter)).extraRoots).toEqual(["/tmp/same/skills"]));
  });

  it("starts the session anyway on a codex build that has no skills/extraRoots/set", async () => {
    // The whole point of the feature detection: this machine runs a preview build ahead of the public
    // release, so -32601 is the expected answer from an older binary and must cost the user nothing but skills.
    const adapter = newAdapter();
    const logs: string[] = [];
    const handle = adapter.start(startOpts({
      env: { FAKE_CODEX_NO_EXTRA_ROOTS: "1" },
      skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" },
      onLog: (l) => logs.push(l),
    }));
    const { evs } = drain(handle);
    await waitFor(() => expect(types(evs)).toContain("init"));
    expect(statuses(evs)).toContain("idle");
    expect(types(evs)).not.toContain("error");
    await waitFor(() => expect(logs.join("\n")).toContain("no skills/extraRoots/set"));
    expect(adapter.skillsSupported).toBe(false);
    // Sticky: a second session must not pay for the same round trip to learn the same thing.
    const before = logs.length;
    const b = adapter.start(startOpts({ env: { FAKE_CODEX_NO_EXTRA_ROOTS: "1" }, skills: { pluginPath: "/tmp/b", root: "/tmp/b/skills" }, onLog: (l) => logs.push(l) }));
    const evsB = drain(b).evs;
    await waitFor(() => expect(types(evsB)).toContain("init"));
    expect(logs.slice(before).join("\n")).not.toContain("no skills/extraRoots/set");
    // And the turn still runs.
    await b.send({ text: "hello", attachments: [] });
    await waitFor(() => expect(texts(evsB).join("")).toContain("hello"));
  });

  it("starts the session anyway when the method exists but fails", async () => {
    const adapter = newAdapter();
    const logs: string[] = [];
    const handle = adapter.start(startOpts({
      env: { FAKE_CODEX_EXTRA_ROOTS_FAIL: "1" },
      skills: { pluginPath: "/tmp/realm-plugin", root: "/tmp/realm-plugin/skills" },
      onLog: (l) => logs.push(l),
    }));
    const { evs } = drain(handle);
    await waitFor(() => expect(types(evs)).toContain("init"));
    expect(types(evs)).not.toContain("error");
    await waitFor(() => expect(logs.join("\n")).toContain("skills/extraRoots/set failed"));
    // A transient failure is not a missing method: the next session must try again.
    expect(adapter.skillsSupported).toBe(true);
    await handle.send({ text: "hello", attachments: [] });
    await waitFor(() => expect(texts(evs).join("")).toContain("hello"));
  });
});

describe("codexMcpConfig", () => {
  const stdio = { name: "airtable", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } };
  const http = { name: "vercel", transport: "http" as const, url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" } };

  it("writes a stdio server as command/args/env under its name", () => {
    expect(codexMcpConfig([stdio])).toEqual({ mcp_servers: { airtable: { command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { K: "v" } } } });
  });

  it("writes an http server as url/http_headers — Codex's own key, not `headers` — which is the only shape that ever reaches here (the gateway's own entry)", () => {
    expect(codexMcpConfig([http])).toEqual({ mcp_servers: { vercel: { url: "https://mcp.vercel.com", http_headers: { Authorization: "Bearer t" } } } });
  });

  it("omits empty args and env rather than sending empty collections", () => {
    const bare = { name: "bare", transport: "stdio" as const, command: "/bin/x", args: [], env: {} };
    expect(codexMcpConfig([bare])).toEqual({ mcp_servers: { bare: { command: "/bin/x" } } });
  });

  it("is undefined when nothing survives, so `config` is omitted from thread/start", () => {
    expect(codexMcpConfig([])).toBeUndefined();
  });
});

/**
 * W3's memory channel on Codex: the same `StartOptions.systemContext` the Claude adapter appends to its
 * system prompt goes to Codex as `thread/start` `developerInstructions` — and the start response's
 * `instructionSources` (the exact files Codex loaded) comes back on this session's init event.
 * `model: "reflect"` makes the fixture echo the whole thread/start params as the model string, which is
 * how the tests see exactly what went on the wire.
 */
describe("CodexAdapter memory", () => {
  const reflected = (evs: SessionEvent[]) => JSON.parse(of(evs, "init")[0]!.payload.model) as Record<string, unknown>;

  it("sends systemContext as developerInstructions on thread/start", async () => {
    const { evs } = await booted({ model: "reflect", systemContext: "REALM CONTEXT 4417" });
    expect(reflected(evs).developerInstructions).toBe("REALM CONTEXT 4417");
  });

  it("omits the field entirely when there is no context, rather than sending an empty string", async () => {
    const { evs } = await booted({ model: "reflect" });
    expect("developerInstructions" in reflected(evs)).toBe(false);
  });

  it("does not send it on thread/resume — a resumed thread keeps what it was started with", async () => {
    const { evs } = await booted({ model: "reflect", resume: "th_prior", systemContext: "REALM CONTEXT 4417" });
    const params = reflected(evs);
    expect(params.threadId).toBe("th_prior");
    expect("developerInstructions" in params).toBe(false);
  });

  it("surfaces the thread's own instructionSources on init — each session gets its own thread's list", async () => {
    // Two sessions on ONE adapter: the shared-process design is exactly where a cross-thread mixup would live.
    // The spawn needs a real cwd (the first session's); the second thread's cwd is only a thread/start param.
    const adapter = newAdapter();
    const cwdA = mkdtempSync(join(tmpdir(), "realm-mem-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "realm-mem-b-"));
    const a = adapter.start(startOpts({ cwd: cwdA }));
    const evsA = drain(a).evs;
    const b = adapter.start(startOpts({ cwd: cwdB }));
    const evsB = drain(b).evs;
    await waitFor(() => expect(types(evsA)).toContain("init"));
    await waitFor(() => expect(types(evsB)).toContain("init"));
    // The fixture derives the list from cwd, so a cross-thread mixup would show as the wrong path here.
    expect(of(evsA, "init")[0]!.payload.instructionSources).toEqual([`${cwdA}/AGENTS.md`]);
    expect(of(evsB, "init")[0]!.payload.instructionSources).toEqual([`${cwdB}/AGENTS.md`]);
  });

  it("leaves instructionSources absent when the server does not report it (older build), not []", async () => {
    const { evs } = await booted({ env: { FAKE_CODEX_NO_INSTRUCTION_SOURCES: "1" } });
    expect("instructionSources" in of(evs, "init")[0]!.payload).toBe(false);
  });
});

describe("CodexAdapter model catalog", () => {
  // The probe's transient app-server child inherits process.env (probe() has no env channel of its
  // own), so the fixture's hooks are toggled here and always cleaned up.
  const HOOKS = ["FAKE_CODEX_NO_MODEL_LIST", "FAKE_CODEX_MODEL_GARBAGE", "FAKE_CODEX_MODEL_PAGES"] as const;
  afterEach(() => { for (const k of HOOKS) delete process.env[k]; });

  it("probe() enumerates model/list over a transient connection and takes it down again", async () => {
    const adapter = newAdapter();
    const r = await adapter.probe();
    expect(r.kind).toBe("codex");
    expect(r.available).toBe(true);
    // The hidden preview model is exactly what `hidden` means — it must not reach the picker.
    expect(r.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" }]);
    // A probe must not leave an app-server child behind: the shared-connection refcount never saw it.
    expect(adapter.processCount).toBe(0);
    expect(adapter.sessionCount).toBe(0);
  });

  it("follows nextCursor across pages", async () => {
    process.env.FAKE_CODEX_MODEL_PAGES = "1";
    const r = await newAdapter().probe();
    expect(r.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.4-mini", label: "GPT-5.4-Mini" }]);
  });

  it("keeps only the well-formed rows of a polluted catalog", async () => {
    process.env.FAKE_CODEX_MODEL_GARBAGE = "1";
    const r = await newAdapter().probe();
    expect(r.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-nameless", label: "gpt-nameless" }]);
  });

  it("degrades -32601 to models:null (a build from before model/list) without failing the probe, sticky", async () => {
    process.env.FAKE_CODEX_NO_MODEL_LIST = "1";
    const adapter = newAdapter();
    const r = await adapter.probe();
    expect(r.available).toBe(true); // the CLI is fine; only enumeration is missing
    expect(r.models).toBeNull();
    expect(adapter.modelListEnumerable).toBe(false);
    // Sticky: the verdict is about the binary, so the next probe must not ask again.
    delete process.env.FAKE_CODEX_NO_MODEL_LIST;
    const again = await adapter.probe();
    expect(again.models).toBeNull();
  });

  it("reports models:null when the CLI itself is unavailable", async () => {
    const r = await new CodexAdapter({ bin: "/definitely/not/a/codex/binary" }).probe();
    expect(r.available).toBe(false);
    expect(r.models).toBeNull();
  });

  it("rides the shared connection when a session already holds one", async () => {
    const adapter = newAdapter();
    const handle = adapter.start(startOpts());
    const { evs } = drain(handle);
    await waitFor(() => expect(types(evs)).toContain("init"));
    expect(adapter.processCount).toBe(1);
    const r = await adapter.probe();
    expect(r.models).not.toBeNull();
    expect(r.models!.length).toBeGreaterThan(0);
    // Still exactly the session's process: the probe neither spawned a second one nor tore this one down.
    expect(adapter.processCount).toBe(1);
    const conn = await adapter.connection!;
    const counted = await conn.request<{ calls: number }>("$test/modelList");
    expect(counted.calls).toBeGreaterThan(0); // the enumeration really went over THIS connection
    await handle.dispose();
    expect(adapter.processCount).toBe(0);
  });
});

import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionEventOf, SessionEventType } from "@realm/contracts";
import { AcpAdapter, acpBootFailureMessage, pickAcpOption, sliceLines, type AcpAgentSpec } from "./acp-adapter";
import { JsonRpcCallError } from "../jsonrpc/stdio";
import type { AgentHandle, StartOptions } from "../types";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const spec = (o: Partial<AcpAgentSpec> = {}): AcpAgentSpec => ({
  kind: "acp:cursor", bin: process.execPath, args: [FAKE],
  label: "Cursor", loginHint: "Run `cursor-agent login`.", ...o,
});
const newAdapter = (o: Partial<AcpAgentSpec> = {}) => new AcpAdapter(spec(o));
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
const errors = (evs: SessionEvent[]) => of(evs, "error").map((e) => e.payload.message);

/** Boots a session and waits for the first terminal event of boot: `init` or `error`. */
async function booted(o: Partial<StartOptions> = {}, s: Partial<AcpAgentSpec> = {}) {
  const adapter = newAdapter(s);
  const handle = adapter.start(startOpts(o));
  const { evs, done } = drain(handle);
  await vi.waitFor(() => expect(types(evs).some((t) => t === "init" || t === "error")).toBe(true));
  return { adapter, handle, evs, done };
}

/** Lets the queue hand everything already pushed to the drain loop, which delivers asynchronously. */
const settled = () => new Promise((r) => setTimeout(r, 0));

/** Runs one turn and waits for it to settle back to idle. */
async function turn(handle: AgentHandle, evs: SessionEvent[], text: string) {
  const before = statuses(evs).length;
  await handle.send({ text, attachments: [] });
  await vi.waitFor(() => expect(statuses(evs).slice(before).at(-1)).toBe("idle"));
}

const ALLOW_ONLY = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "a2", name: "Always allow", kind: "allow_always" },
];
const FULL = [...ALLOW_ONLY, { optionId: "r1", name: "Reject", kind: "reject_once" }, { optionId: "r2", name: "Always reject", kind: "reject_always" }];

describe("pickAcpOption", () => {
  it("prefers allow_once for allow and falls back to allow_always", () => {
    expect(pickAcpOption("allow", FULL)).toBe("a1");
    expect(pickAcpOption("allow", [FULL[1]!, FULL[2]!])).toBe("a2");
  });

  it("prefers allow_always for allow_always and falls back to allow_once", () => {
    expect(pickAcpOption("allow_always", FULL)).toBe("a2");
    expect(pickAcpOption("allow_always", [FULL[0]!, FULL[2]!])).toBe("a1");
  });

  it("prefers reject_once for deny and falls back to reject_always", () => {
    expect(pickAcpOption("deny", FULL)).toBe("r1");
    expect(pickAcpOption("deny", [FULL[0]!, FULL[3]!])).toBe("r2");
  });

  it("returns null rather than degrading a deny into an allow", () => {
    // The caller answers {outcome:"cancelled"} on null. Falling back to options[0] here would silently
    // execute the very tool call the user just rejected.
    expect(pickAcpOption("deny", ALLOW_ONLY)).toBeNull();
    expect(pickAcpOption("deny", [])).toBeNull();
  });

  it("returns null when no option matches an allow either", () => {
    expect(pickAcpOption("allow", [FULL[2]!])).toBeNull();
    expect(pickAcpOption("allow_always", [FULL[3]!])).toBeNull();
    expect(pickAcpOption("allow", [])).toBeNull();
  });

  it("ignores malformed options instead of picking them", () => {
    expect(pickAcpOption("allow", [null, 7, { name: "no kind" }, { optionId: "x", kind: "allow_once" }])).toBe("x");
    expect(pickAcpOption("allow", [{ kind: "allow_once" }])).toBeNull(); // no optionId to echo back
  });
});

describe("sliceLines", () => {
  const FOUR = "one\ntwo\nthree\nfour\n";

  it("returns the whole file when the agent asked for no window", () => {
    expect(sliceLines(FOUR, undefined, undefined)).toBe(FOUR);
    expect(sliceLines(FOUR, null, null)).toBe(FOUR);
  });

  it("treats line as 1-based and limit as a line count", () => {
    expect(sliceLines(FOUR, 2, 2)).toBe("two\nthree");
    expect(sliceLines(FOUR, 1, 1)).toBe("one");
  });

  it("honours line on its own", () => {
    expect(sliceLines(FOUR, 3, undefined)).toBe("three\nfour\n");
    expect(sliceLines(FOUR, 1, null)).toBe(FOUR);
  });

  it("honours limit on its own", () => {
    expect(sliceLines(FOUR, undefined, 2)).toBe("one\ntwo");
    expect(sliceLines(FOUR, null, 1)).toBe("one");
  });

  it("clamps a line before the start of the file", () => {
    expect(sliceLines(FOUR, 0, 1)).toBe("one");
    expect(sliceLines(FOUR, -5, 1)).toBe("one");
  });
});

describe("acpBootFailureMessage", () => {
  const SPEC = { label: "Cursor", loginHint: "Run `cursor-agent login`." };
  const AUTH = [{ id: "cursor_login", name: "Cursor Login" }];

  it("leaves a non-protocol failure alone", () => {
    // A missing binary or a dead pipe is not a login problem; appending the hint would misdirect the user.
    const msg = acpBootFailureMessage(new Error("spawn cursor-agent ENOENT"), SPEC, AUTH);
    expect(msg).toBe("spawn cursor-agent ENOENT");
  });

  it("names the agent, the auth methods and the hint on -32000", () => {
    const msg = acpBootFailureMessage(new JsonRpcCallError(-32000, "API key is missing.", undefined), SPEC, AUTH);
    expect(msg).toContain("Cursor");
    expect(msg).toContain("sign in");
    expect(msg).toContain("API key is missing.");
    expect(msg).toContain("Cursor Login");
    expect(msg).toContain("Run `cursor-agent login`.");
  });

  it("echoes Cursor's -32603 data verbatim and still appends the hint", () => {
    const e = new JsonRpcCallError(-32603, "Internal error", { message: "Failed to initialize session services", details: "[unauthenticated] Error" });
    const msg = acpBootFailureMessage(e, SPEC, AUTH);
    expect(msg).toContain("Internal error");
    expect(msg).toContain("Failed to initialize session services");
    expect(msg).toContain("[unauthenticated] Error");
    expect(msg).toContain("Run `cursor-agent login`.");
    expect(msg).not.toContain("sign in"); // -32603 is generic: do not claim to know it is an auth problem
  });

  it("falls back to auth method ids and copes with no auth methods at all", () => {
    const e = new JsonRpcCallError(-32000, "nope", undefined);
    expect(acpBootFailureMessage(e, SPEC, [{ id: "vertex-ai" }])).toContain("vertex-ai");
    const bare = acpBootFailureMessage(e, SPEC, []);
    expect(bare).not.toContain("Sign-in methods");
    expect(bare).toContain("Run `cursor-agent login`.");
  });
});

describe("AcpAdapter", () => {
  it("reports the kind it was constructed with", () => {
    expect(newAdapter().kind).toBe("acp:cursor");
    expect(newAdapter({ kind: "acp:gemini" }).kind).toBe("acp:gemini");
  });

  it("probes the configured binary and tags the result with its kind", async () => {
    const good = await newAdapter().probe(); // process.execPath --version
    expect(good).toMatchObject({ kind: "acp:cursor", available: true, loggedIn: null });
    expect(good.version).toMatch(/^v?\d/);
    const bad = await newAdapter({ kind: "acp:gemini", bin: "/nonexistent/acp-bin" }).probe();
    expect(bad).toMatchObject({ kind: "acp:gemini", available: false, version: null });
  });

  it("spawns the child in the session's cwd and lets session env override the spec's", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const png = join(dir, "shot.png");
    await writeFile(png, Buffer.from([1, 2, 3, 4]));
    // The spec's env is a default for the agent; a session's own env is the more specific value and wins.
    const { handle, evs } = await booted({ cwd: dir, env: { FAKE_ACP_NOIMAGE: "" } }, { env: { FAKE_ACP_NOIMAGE: "1" } });
    await handle.send({ text: "ECHO", attachments: [{ path: png, mime: "image/png" }] });
    await vi.waitFor(() => expect(texts(evs)).toHaveLength(1));
    expect((JSON.parse(texts(evs)[0]!) as Record<string, unknown>[])[1]).toMatchObject({ type: "image" });
    await turn(handle, evs, "REVEAL");
    expect((JSON.parse(texts(evs)[1]!) as { cwd: string }).cwd).toBe(dir);
    await handle.dispose();
  });

  it("fails the session when the agent answers session/new without a session id", async () => {
    const { evs, done } = await booted({}, { env: { FAKE_ACP_NOSESSIONID: "1" } });
    await done;
    expect(errors(evs)[0]).toContain("Cursor did not return a session id");
    expect(statuses(evs)).toEqual(["error", "ended"]);
  });

  it("survives a malformed authMethods on the failure path", async () => {
    const { evs, done } = await booted({}, { env: { FAKE_ACP_AUTHFAIL: "1", FAKE_ACP_BADAUTH: "1" } });
    await done;
    expect(errors(evs)[0]).toContain("Run `cursor-agent login`.");
    expect(errors(evs)[0]).not.toContain("Sign-in methods");
    expect(statuses(evs)).toEqual(["error", "ended"]);
  });

  it("emits init then a full streaming turn, and never a user_message", async () => {
    const { handle, evs } = await booted();
    const init = of(evs, "init")[0]!;
    expect(init.payload.providerSessionId).toBe("sess_0");
    expect(init.payload.model).toBe("fake-model-1");
    expect(init.payload.cwd).toBe(process.cwd());
    expect(statuses(evs)).toEqual(["idle"]);

    await turn(handle, evs, "hi");
    expect(of(evs, "assistant_delta").map((e) => e.payload.delta)).toEqual(["Hel", "lo"]);
    expect(texts(evs)).toEqual(["Hello"]);
    expect(of(evs, "thinking").map((e) => e.payload.text)).toEqual(["pondering"]);
    expect(statuses(evs)).toEqual(["idle", "running", "idle"]);
    // SessionService emits user_message itself; a second one from the adapter would double every message.
    expect(types(evs)).not.toContain("user_message");
    expect(errors(evs)).toEqual([]);
    await handle.dispose();
  });

  it("accepts a send that arrives before the boot has finished", async () => {
    const handle = newAdapter().start(startOpts());
    const { evs } = drain(handle);
    await handle.send({ text: "hi", attachments: [] }); // no wait for init
    await vi.waitFor(() => expect(texts(evs)).toEqual(["Hello"]));
    expect(types(evs).indexOf("init")).toBeLessThan(types(evs).indexOf("assistant_text"));
    await handle.dispose();
  });

  it("reports a child that dies during the handshake once, then ends", async () => {
    const handle = newAdapter({ args: ["-e", "process.exit(3)"] }).start(startOpts());
    const { evs, done } = drain(handle);
    await done;
    expect(errors(evs)).toHaveLength(1);
    expect(errors(evs)[0]).toMatch(/exited/);
    expect(statuses(evs)).toEqual(["error", "ended"]);
  });

  it("returns from send() without waiting for the turn to finish", async () => {
    const { handle, evs } = await booted();
    const t0 = Date.now();
    await handle.send({ text: "HANG", attachments: [] });
    const elapsed = Date.now() - t0;
    // session/prompt stays pending for the whole turn. SessionService.send() awaits this, and the RPC method
    // awaits that, so awaiting the prompt would hang the WebSocket call for the length of the turn.
    expect(elapsed).toBeLessThan(1000);
    await vi.waitFor(() => expect(statuses(evs)).toEqual(["idle", "running"]));
    await handle.interrupt();
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    // The connection survives cancellation: the agent flushed "bye" before resolving, and the next turn works.
    expect(texts(evs)).toEqual(["bye"]);
    expect(errors(evs)).toEqual([]);
    await turn(handle, evs, "again");
    expect(texts(evs)).toEqual(["bye", "Hello"]);
    await handle.dispose();
  });

  it("bridges a permission request, allows it, and surfaces the tool result", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    const req = of(evs, "permission_request")[0]!.payload;
    expect(statuses(evs)).toEqual(["idle", "running", "waiting_permission"]);
    // The request's toolCall is a sparse patch carrying only toolCallId, so both the name and the input come
    // from the tool_call the mapper already recorded.
    expect(req.toolName).toBe("Run step 0");
    expect(req.title).toBe("Run step 0");
    expect(req.input).toEqual({ command: "echo 0" });
    expect(req.suggestions).toHaveLength(3);
    expect(req.suggestions[0]).toMatchObject({ optionId: "allow-once", kind: "allow_once" });

    handle.respondPermission(req.requestId, "allow");
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(of(evs, "permission_response")[0]!.payload).toEqual({ requestId: req.requestId, decision: "allow" });
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "outcome:allow-once", isError: false });
    expect(statuses(evs)).toEqual(["idle", "running", "waiting_permission", "running", "idle"]);
    await handle.dispose();
  });

  it("echoes the reject option a deny maps to", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "outcome:reject-once", isError: true });
    await handle.dispose();
  });

  it("answers cancelled — never an allow — when the agent offers no reject option", async () => {
    const { handle, evs } = await booted({}, { env: { FAKE_ACP_ALLOWONLY: "1" } });
    await handle.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("outcome:cancelled");
    await handle.dispose();
  });

  it("raises waiting_permission once while two requests are open", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT2", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(2));
    expect(statuses(evs).filter((s) => s === "waiting_permission")).toHaveLength(1);
    const [a, b] = of(evs, "permission_request").map((e) => e.payload.requestId);
    handle.respondPermission(a!, "allow");
    await settled();
    // One answer does not end the wait — the other request is still open.
    expect(statuses(evs).at(-1)).toBe("waiting_permission");
    handle.respondPermission(b!, "allow_always");
    await vi.waitFor(() => expect(statuses(evs).filter((s) => s === "running")).toHaveLength(2));
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(statuses(evs)).toEqual(["idle", "running", "waiting_permission", "running", "idle"]);
    expect(of(evs, "tool_result").map((e) => e.payload.content).sort()).toEqual(["outcome:allow-always", "outcome:allow-once"]);
    await handle.dispose();
  });

  it("cancels every open permission on interrupt without killing the connection", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.interrupt();
    await vi.waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("outcome:cancelled");
    expect(of(evs, "permission_response")).toHaveLength(1);
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(types(evs)).not.toContain("error");
    await handle.dispose();
  });

  it("drops the session/load replay instead of appending it to the transcript", async () => {
    const { handle, evs } = await booted({ resume: "sess_prev" });
    expect(of(evs, "init")[0]!.payload.providerSessionId).toBe("sess_prev");
    // Realm already persisted this conversation; re-emitting the replay would duplicate every turn.
    expect(types(evs)).not.toContain("assistant_text");
    expect(types(evs)).not.toContain("assistant_delta");
    expect(types(evs)).not.toContain("tool_call");
    // …and the flag is cleared afterwards, or the session would be permanently mute.
    await turn(handle, evs, "hi");
    expect(texts(evs)).toEqual(["Hello"]);
    await handle.dispose();
  });

  it("loads the resumed session with cwd and mcpServers", async () => {
    const { handle, evs } = await booted({ resume: "sess_prev" });
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { loadParams: unknown; newParams: unknown };
    expect(journal.loadParams).toEqual({ sessionId: "sess_prev", cwd: process.cwd(), mcpServers: [] });
    expect(journal.newParams).toBeNull(); // a successful load must not also start a fresh session
    await handle.dispose();
  });

  it("starts a new session when the agent does not advertise loadSession", async () => {
    const { handle, evs } = await booted({ resume: "sess_prev" }, { env: { FAKE_ACP_NOLOAD: "1" } });
    expect(of(evs, "init")[0]!.payload.providerSessionId).toBe("sess_0");
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { loadParams: unknown; newParams: unknown };
    expect(journal.loadParams).toBeNull();
    expect(journal.newParams).toMatchObject({ cwd: process.cwd() });
    await handle.dispose();
  });

  it("falls back to a new session when session/load fails", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ resume: "sess_prev", onLog: (l) => logs.push(l) }, { env: { FAKE_ACP_LOADFAIL: "1" } });
    expect(of(evs, "init")[0]!.payload.providerSessionId).toBe("sess_0");
    expect(errors(evs)).toEqual([]); // a failed resume is recoverable, not a session failure
    expect(logs.join("\n")).toContain("no such session on disk");
    // The flag is cleared by the failure too, so the fresh session is not mute.
    await turn(handle, evs, "hi");
    expect(texts(evs)).toEqual(["Hello"]);
    await handle.dispose();
  });

  it("surfaces an auth failure with the agent label, its auth methods and the login hint", async () => {
    const { evs, done } = await booted({}, { env: { FAKE_ACP_AUTHFAIL: "1" } });
    await done;
    const msg = errors(evs)[0]!;
    expect(msg).toContain("Cursor");
    expect(msg).toContain("This client is no longer supported for individuals.");
    expect(msg).toContain("Fake Login");
    expect(msg).toContain("Run `cursor-agent login`.");
    expect(statuses(evs)).toEqual(["error", "ended"]);
    expect(types(evs)).not.toContain("init");
  });

  it("surfaces Cursor's generic -32603 startup failure verbatim, hint included", async () => {
    const { evs, done } = await booted({}, { env: { FAKE_ACP_STARTFAIL: "1" } });
    await done;
    const msg = errors(evs)[0]!;
    expect(msg).toContain("Failed to initialize session services");
    expect(msg).toContain("[unauthenticated] Error");
    expect(msg).toContain("Run `cursor-agent login`.");
  });

  it("reports a binary that does not exist without the login hint", async () => {
    const { evs, done } = await booted({}, { bin: "/nonexistent/acp-bin" });
    await done;
    expect(errors(evs)[0]).toContain("/nonexistent/acp-bin");
    expect(errors(evs)[0]).not.toContain("cursor-agent login");
  });

  it("serves fs/read_text_file, honouring line and limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const path = join(dir, "NOTES.txt");
    await writeFile(path, "one\ntwo\nthree\nfour\n");
    const { handle, evs } = await booted();
    await turn(handle, evs, `READFILE ${path}`);
    expect(texts(evs)[0]).toBe("read:one\ntwo\nthree\nfour\n");
    await turn(handle, evs, `READFILE ${path} 2 2`);
    expect(texts(evs)[1]).toBe("read:two\nthree");
    await turn(handle, evs, `READFILE ${path} 3`); // a line with no limit runs to the end of the file
    expect(texts(evs)[2]).toBe("read:three\nfour\n");
    await turn(handle, evs, `READFILE ${join(dir, "missing.txt")}`);
    expect(texts(evs)[3]).toContain("read failed:");
    await handle.dispose();
  });

  it("serves fs/write_text_file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const path = join(dir, "OUT.txt");
    const { handle, evs } = await booted();
    await turn(handle, evs, `WRITEFILE ${path} written by the agent`);
    expect(texts(evs)[0]).toBe("write:ok");
    expect(await readFile(path, "utf8")).toBe("written by the agent");
    await handle.dispose();
  });

  it("answers an undeclared client method with -32601 instead of stalling the turn", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ onLog: (l) => logs.push(l) });
    // terminal/* is probed even though clientCapabilities.terminal is false; an unanswered request would
    // leave this turn pending forever, so reaching idle at all is the assertion.
    await turn(handle, evs, "ODDBALL");
    expect(texts(evs)[0]).toBe("terminal refused: -32601");
    expect(logs.join("\n")).toContain("terminal/create");
    await handle.dispose();
  });

  it("declares the fs capabilities and no terminal in initialize", async () => {
    const { handle, evs } = await booted();
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { calls: { method: string; params: Record<string, unknown> }[] };
    expect(journal.calls[0]).toEqual({
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } },
    });
    await handle.dispose();
  });

  it("sends mcp servers with env as name/value pairs, not a record", async () => {
    const { handle, evs } = await booted({ mcpServers: [{ name: "realm", command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: { A: "1", B: "2" } }] });
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { newParams: { cwd: string; mcpServers: unknown[] } };
    expect(journal.newParams.mcpServers).toEqual([
      { name: "realm", command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] },
    ]);
    await handle.dispose();
  });

  it("sends an empty mcpServers array when there is nothing to configure", async () => {
    const { handle, evs } = await booted();
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { newParams: { mcpServers: unknown[] } };
    expect(journal.newParams.mcpServers).toEqual([]); // required, not optional
    await handle.dispose();
  });

  it("inlines image attachments as base64 when the agent accepts images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const png = join(dir, "shot.png");
    await writeFile(png, Buffer.from([1, 2, 3, 4]));
    const { handle, evs } = await booted();
    await handle.send({ text: "ECHO", attachments: [{ path: png, mime: "image/png" }] });
    await vi.waitFor(() => expect(texts(evs)).toHaveLength(1));
    const prompt = JSON.parse(texts(evs)[0]!) as Record<string, unknown>[];
    expect(prompt[0]).toEqual({ type: "text", text: "ECHO" });
    expect(prompt[1]).toEqual({ type: "image", data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "image/png" });
    await handle.dispose();
  });

  it("links images instead of inlining them when the agent does not accept images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const png = join(dir, "shot.png");
    await writeFile(png, Buffer.from([1, 2, 3, 4]));
    const { handle, evs } = await booted({}, { env: { FAKE_ACP_NOIMAGE: "1" } });
    await turn(handle, evs, "ECHO");
    const prompt = JSON.parse(texts(evs)[0]!) as Record<string, unknown>[];
    expect(prompt).toHaveLength(1);
    const linked = await booted({}, { env: { FAKE_ACP_NOIMAGE: "1" } });
    await linked.handle.send({ text: "ECHO", attachments: [{ path: png, mime: "image/png" }] });
    await vi.waitFor(() => expect(texts(linked.evs)).toHaveLength(1));
    expect((JSON.parse(texts(linked.evs)[0]!) as Record<string, unknown>[])[1])
      .toEqual({ type: "resource_link", uri: `file://${png}`, name: "shot.png", mimeType: "image/png" });
    await handle.dispose();
    await linked.handle.dispose();
  });

  it("links non-image attachments rather than embedding them", async () => {
    const { handle, evs } = await booted();
    // Cursor reports embeddedContext:false, so a `resource` block would be rejected outright.
    await handle.send({ text: "ECHO", attachments: [{ path: "/tmp/notes.txt", mime: "text/plain" }] });
    await vi.waitFor(() => expect(texts(evs)).toHaveLength(1));
    const prompt = JSON.parse(texts(evs)[0]!) as Record<string, unknown>[];
    expect(prompt[1]).toEqual({ type: "resource_link", uri: "file:///tmp/notes.txt", name: "notes.txt", mimeType: "text/plain" });
    await handle.dispose();
  });

  it("gives refusal and max_tokens their own copy and stays quiet for the rest", async () => {
    const { handle, evs } = await booted();
    await turn(handle, evs, "STOP:refusal");
    expect(errors(evs)[0]).toMatch(/refus/i);
    await turn(handle, evs, "STOP:max_tokens");
    expect(errors(evs)[1]).toMatch(/token/i);
    await turn(handle, evs, "STOP:end_turn");
    await turn(handle, evs, "STOP:cancelled");
    expect(errors(evs)).toHaveLength(2); // end_turn and cancelled are normal outcomes, not failures
    expect(statuses(evs).filter((s) => s === "idle")).toHaveLength(5);
    await handle.dispose();
  });

  it("reports a failed prompt and settles back to idle", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "FAIL", attachments: [] });
    await vi.waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(errors(evs)[0]).toContain("prompt exploded");
    await handle.dispose();
  });

  it("applies setOptions best-effort and swallows what the agent refuses", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ onLog: (l) => logs.push(l) });
    await handle.setOptions({ model: "fake-model-2", permissionMode: "plan" });
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { calls: { method: string; params: Record<string, unknown> }[] };
    const calls = Object.fromEntries(journal.calls.map((c) => [c.method, c.params]));
    expect(calls["session/set_mode"]).toEqual({ sessionId: "sess_0", modeId: "plan" });
    expect(calls["session/set_model"]).toEqual({ sessionId: "sess_0", modelId: "fake-model-2" });
    // session/set_model is unstable in 0.4.5; its rejection is a log line, not a session error.
    expect(errors(evs)).toEqual([]);
    expect(logs.join("\n")).toContain("session/set_model");
    await handle.dispose();
  });

  it("emits no error on a deliberate dispose, and ends the stream", async () => {
    const { handle, evs, done } = await booted();
    await handle.dispose();
    await done;
    expect(types(evs)).not.toContain("error");
    expect(statuses(evs)).toEqual(["idle", "ended"]);
    await handle.dispose(); // idempotent
    expect(statuses(evs)).toEqual(["idle", "ended"]);
  });

  it("takes the child process down with the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const marker = join(dir, "child-exited");
    const { handle } = await booted({}, { env: { FAKE_ACP_EXIT_MARKER: marker } });
    expect(existsSync(marker)).toBe(false);
    await handle.dispose();
    // dispose() does not resolve until the child is actually gone, so this needs no polling.
    expect(existsSync(marker)).toBe(true);
  });

  it("flushes a half-streamed message when the session is disposed", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "OPENTEXT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "assistant_delta")).toHaveLength(1));
    await handle.dispose();
    await done;
    // assistant_delta is ephemeral: without the flush the partial answer never reaches the transcript at all.
    expect(texts(evs)).toEqual(["partial"]);
  });

  it("answers a permission still open at dispose instead of leaving it dangling", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    const { requestId } = of(evs, "permission_request")[0]!.payload;
    await handle.dispose();
    await done;
    // A request with no response leaves a card the UI renders as still waiting, forever.
    expect(of(evs, "permission_response").map((e) => e.payload)).toEqual([{ requestId, decision: "deny" }]);
  });

  it("cancels a permission that arrives while the session is being torn down", async () => {
    const { handle, evs, done } = await booted({}, { env: { FAKE_ACP_IGNORE_EOF: "1" } });
    await handle.send({ text: "LATEPERMIT", attachments: [] });
    // dispose() only resolves once the child is gone, so the late request has certainly arrived by then.
    await handle.dispose();
    await done;
    expect(types(evs)).not.toContain("permission_request");
    expect(statuses(evs)).not.toContain("waiting_permission");
    expect(statuses(evs).at(-1)).toBe("ended");
  });

  it("closes a tool call that is still open when the session is disposed", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "OPENTOOL", attachments: [] });
    await vi.waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
    await handle.dispose();
    await done;
    expect(of(evs, "tool_result")[0]!.payload).toEqual({ toolUseId: of(evs, "tool_call")[0]!.payload.toolUseId, content: "session closed", isError: true });
    expect(types(evs)).not.toContain("error"); // a dispose is not a failure, open card or not
    expect(statuses(evs).at(-1)).toBe("ended");
  });

  it("closes an open tool call and reports an error when the child dies unexpectedly", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "DIE", attachments: [] });
    await done;
    expect(errors(evs)[0]).toMatch(/exited/);
    // The card is closed with why the child died, not with the generic dispose reason.
    expect(of(evs, "tool_result")[0]!.payload.content).toMatch(/exited/);
    expect(of(evs, "tool_result")[0]!.payload.isError).toBe(true);
    expect(statuses(evs)).toEqual(["idle", "running", "error", "ended"]);
    await handle.dispose();
  });

  it("refuses a message once the session has ended", async () => {
    const { handle, evs } = await booted();
    await handle.dispose();
    await handle.send({ text: "hi", attachments: [] });
    expect(errors(evs)).toEqual([]); // the stream is closed; nothing can be pushed onto it any more
  });

  it("serves fs callbacks during a replay but cancels permission requests raised by it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const path = join(dir, "REPLAY.txt");
    await writeFile(path, "replayed content");
    const { handle, evs } = await booted(
      { resume: "sess_prev" },
      { env: { FAKE_ACP_LOAD_ASKS: "1", FAKE_ACP_LOAD_ASKS_PATH: path } },
    );
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { replayAsks: { read: { result?: { content: string } }; permission: { result?: { outcome: { outcome: string } } } } };
    expect(journal.replayAsks.read.result).toEqual({ content: "replayed content" });
    // There is no live turn behind a replayed permission request and no user watching for it, so it is
    // answered `cancelled` and never reaches the transcript.
    expect(journal.replayAsks.permission.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(types(evs)).not.toContain("permission_request");
    expect(statuses(evs)).not.toContain("waiting_permission");
    await handle.dispose();
  });
});

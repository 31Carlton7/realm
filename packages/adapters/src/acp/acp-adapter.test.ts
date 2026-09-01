import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent, SessionEventOf, SessionEventType } from "@realm/contracts";
import { AcpAdapter, acpBootFailureMessage, acpMcpServers, MAX_FS_READ_BYTES, pickAcpOption, sliceLines, type AcpAgentSpec } from "./acp-adapter";
import { JsonRpcCallError } from "../jsonrpc/stdio";
import type { AgentHandle, StartOptions } from "../types";

/**
 * Every assertion in this file is gated on a real child process: node cold start, module load and at least one
 * round trip. vitest's 1000 ms default is routinely too tight for that on a loaded two-core CI runner, and a
 * longer bound costs nothing when the assertion passes.
 */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 10_000, interval: 25 });

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const spec = (o: Partial<AcpAgentSpec> = {}): AcpAgentSpec => ({
  kind: "acp:cursor", bin: process.execPath, args: [FAKE],
  label: "Cursor", loginHint: "Run `cursor-agent login`.", ...o,
});
const newAdapter = (o: Partial<AcpAgentSpec> = {}) => new AcpAdapter(spec(o));
const startOpts = (o: Partial<StartOptions> = {}): StartOptions => ({ cwd: process.cwd(), mcpServers: [], ...o });

/** Drains the handle's event stream into an array the assertions poll with `waitFor`. */
function drain(h: AgentHandle) {
  live.push(h);
  const evs: SessionEvent[] = [];
  const done = (async () => { for await (const e of h.events) evs.push(e); })();
  return { evs, done };
}

/** Every handle a test drained. A failing assertion skips the test's own dispose(); this stops that leaking a
 *  child process into the rest of the run. */
const live: AgentHandle[] = [];
afterEach(async () => { for (const h of live.splice(0)) await h.dispose().catch(() => {}); });
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
  await waitFor(() => expect(types(evs).some((t) => t === "init" || t === "error")).toBe(true));
  return { adapter, handle, evs, done };
}

/** Runs one turn and waits for it to settle back to idle. */
async function turn(handle: AgentHandle, evs: SessionEvent[], text: string) {
  const before = statuses(evs).length;
  await handle.send({ text, attachments: [] });
  await waitFor(() => expect(statuses(evs).slice(before).at(-1)).toBe("idle"));
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
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
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
    await waitFor(() => expect(texts(evs)).toEqual(["Hello"]));
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
    await waitFor(() => expect(statuses(evs)).toEqual(["idle", "running"]));
    await handle.interrupt();
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
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
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
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
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(of(evs, "permission_response")[0]!.payload).toEqual({ requestId: req.requestId, decision: "allow" });
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "outcome:allow-once", isError: false });
    expect(statuses(evs)).toEqual(["idle", "running", "waiting_permission", "running", "idle"]);
    await handle.dispose();
  });

  it("echoes the reject option a deny maps to", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload).toMatchObject({ content: "outcome:reject-once", isError: true });
    await handle.dispose();
  });

  it("answers cancelled — never an allow — when the agent offers no reject option", async () => {
    const { handle, evs } = await booted({}, { env: { FAKE_ACP_ALLOWONLY: "1" } });
    await handle.send({ text: "PERMIT", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    handle.respondPermission(of(evs, "permission_request")[0]!.payload.requestId, "deny");
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("outcome:cancelled");
    await handle.dispose();
  });

  it("raises waiting_permission once while two requests are open", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT2", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(2));
    expect(statuses(evs).filter((s) => s === "waiting_permission")).toHaveLength(1);
    const [a, b] = of(evs, "permission_request").map((e) => e.payload.requestId);
    handle.respondPermission(a!, "allow");
    // A positive signal rather than one macrotask: the agent completes that call as soon as it is answered,
    // so its tool_result is proof the answer was delivered and acted on.
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    // One answer does not end the wait — the other request is still open.
    expect(statuses(evs).at(-1)).toBe("waiting_permission");
    handle.respondPermission(b!, "allow_always");
    await waitFor(() => expect(statuses(evs).filter((s) => s === "running")).toHaveLength(2));
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
    expect(statuses(evs)).toEqual(["idle", "running", "waiting_permission", "running", "idle"]);
    expect(of(evs, "tool_result").map((e) => e.payload.content).sort()).toEqual(["outcome:allow-always", "outcome:allow-once"]);
    await handle.dispose();
  });

  it("cancels every open permission on interrupt without killing the connection", async () => {
    const { handle, evs } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
    await handle.interrupt();
    await waitFor(() => expect(of(evs, "tool_result")).toHaveLength(1));
    expect(of(evs, "tool_result")[0]!.payload.content).toBe("outcome:cancelled");
    expect(of(evs, "permission_response")).toHaveLength(1);
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
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
    const { handle, evs } = await booted({ cwd: dir });
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
    const path = join(dir, "OUT.txt"); // does not exist yet: the target is resolved through its parent
    const { handle, evs } = await booted({ cwd: dir });
    await turn(handle, evs, `WRITEFILE ${path} written by the agent`);
    expect(texts(evs)[0]).toBe("write:ok");
    expect(await readFile(path, "utf8")).toBe("written by the agent");
    await handle.dispose();
  });

  it("refuses to read a path that escapes the session's working directory", async () => {
    // Absolute paths are all an agent needs to ask for ~/.ssh/id_rsa or ~/.aws/credentials, and none of this
    // reaches a permission card. Declaring fs:false would not take the capability away — but confining our own
    // handlers costs a well-behaved agent nothing, it just falls back to its own I/O.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const work = join(dir, "work");
    await mkdir(work);
    const outside = join(dir, "SECRET.txt");
    await writeFile(outside, "credentials");
    const logs: string[] = [];
    const { handle, evs } = await booted({ cwd: work, onLog: (l) => logs.push(l) });
    await turn(handle, evs, `READFILE ${outside}`);
    expect(texts(evs)[0]).toContain("read failed:");
    expect(texts(evs)[0]).toContain("outside");
    await turn(handle, evs, `READFILE ../../../etc/passwd`); // relative traversal, resolved against cwd
    expect(texts(evs)[1]).toContain("outside");
    expect(logs.join("\n")).toContain("outside");
    await handle.dispose();
  });

  it("refuses to write outside the working directory and leaves the target untouched", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const work = join(dir, "work");
    await mkdir(work);
    const outside = join(dir, "ZSHRC");
    await writeFile(outside, "original");
    const { handle, evs } = await booted({ cwd: work });
    await turn(handle, evs, `WRITEFILE ${outside} clobbered`);
    expect(texts(evs)[0]).toContain("write failed:");
    expect(await readFile(outside, "utf8")).toBe("original");
    // …and a brand new file outside cwd is not created either.
    await turn(handle, evs, `WRITEFILE ${join(dir, "NEW.txt")} hello`);
    expect(texts(evs)[1]).toContain("write failed:");
    expect(existsSync(join(dir, "NEW.txt"))).toBe(false);
    await handle.dispose();
  });

  it("refuses a symlink inside the working directory that points outside it", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const work = join(dir, "work");
    await mkdir(work);
    const outside = join(dir, "SECRET.txt");
    await writeFile(outside, "credentials");
    // Resolving the link is the whole point: a containment check on the literal path would wave this through.
    await symlink(outside, join(work, "innocent.txt"));
    const { handle, evs } = await booted({ cwd: work });
    await turn(handle, evs, `READFILE ${join(work, "innocent.txt")}`);
    expect(texts(evs)[0]).toContain("outside");
    expect(texts(evs)[0]).not.toContain("credentials");
    await turn(handle, evs, `WRITEFILE ${join(work, "innocent.txt")} clobbered`);
    expect(texts(evs)[1]).toContain("write failed:");
    expect(await readFile(outside, "utf8")).toBe("credentials");
    await handle.dispose();
  });

  it("refuses a sibling directory whose name merely starts with the working directory's", async () => {
    // /…/work-evil is not inside /…/work, however much a naive prefix test would like it to be.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const work = join(dir, "work");
    await mkdir(work);
    await mkdir(join(dir, "work-evil"));
    const sibling = join(dir, "work-evil", "SECRET.txt");
    await writeFile(sibling, "credentials");
    const { handle, evs } = await booted({ cwd: work });
    await turn(handle, evs, `READFILE ${sibling}`);
    expect(texts(evs)[0]).toContain("outside");
    expect(texts(evs)[0]).not.toContain("credentials");
    await handle.dispose();
  });

  it("refuses to read a file past the size cap", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "realm-acp-")));
    const huge = join(dir, "HUGE.bin");
    await writeFile(huge, "");
    await truncate(huge, MAX_FS_READ_BYTES + 1); // sparse: no real bytes written
    const { handle, evs } = await booted({ cwd: dir });
    await turn(handle, evs, `READFILE ${huge}`);
    expect(texts(evs)[0]).toContain("read failed:");
    expect(texts(evs)[0]).toMatch(/too large|bytes/);
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
    const { handle, evs } = await booted({ mcpServers: [{ name: "realm", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/realm-mcp.mjs"], env: { A: "1", B: "2" } }] });
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
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
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
    await waitFor(() => expect(texts(linked.evs)).toHaveLength(1));
    expect((JSON.parse(texts(linked.evs)[0]!) as Record<string, unknown>[])[1])
      .toEqual({ type: "resource_link", uri: `file://${png}`, name: "shot.png", mimeType: "image/png" });
    await handle.dispose();
    await linked.handle.dispose();
  });

  it("links non-image attachments rather than embedding them", async () => {
    const { handle, evs } = await booted();
    // Cursor reports embeddedContext:false, so a `resource` block would be rejected outright.
    await handle.send({ text: "ECHO", attachments: [{ path: "/tmp/notes.txt", mime: "text/plain" }] });
    await waitFor(() => expect(texts(evs)).toHaveLength(1));
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
    await waitFor(() => expect(statuses(evs).at(-1)).toBe("idle"));
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
    await waitFor(() => expect(of(evs, "assistant_delta")).toHaveLength(1));
    await handle.dispose();
    await done;
    // assistant_delta is ephemeral: without the flush the partial answer never reaches the transcript at all.
    expect(texts(evs)).toEqual(["partial"]);
  });

  it("answers a permission still open at dispose instead of leaving it dangling", async () => {
    const { handle, evs, done } = await booted();
    await handle.send({ text: "PERMIT", attachments: [] });
    await waitFor(() => expect(of(evs, "permission_request")).toHaveLength(1));
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
    await waitFor(() => expect(of(evs, "tool_call")).toHaveLength(1));
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

  it("bounds initialize so a child that spawns and answers nothing cannot hang the session", async () => {
    // No timeout here and boot stays pending forever: dispose() -> App.close() never returns and the desktop
    // main process SIGTERMs the server out from under its agent children.
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const marker = join(dir, "child-exited");
    const adapter = newAdapter({ bootTimeoutMs: 200, env: { FAKE_ACP_MUTE_INITIALIZE: "1", FAKE_ACP_EXIT_MARKER: marker } });
    const handle = adapter.start(startOpts());
    const { evs, done } = drain(handle);
    // send() and setOptions() await boot too, so a bounded boot is what stops them hanging the WebSocket
    // call as well — neither has a timeout of its own.
    await expect(handle.send({ text: "hi", attachments: [] })).resolves.toBeUndefined();
    await expect(handle.setOptions({ model: "x" })).resolves.toBeUndefined();
    await done;
    expect(errors(evs)[0]).toMatch(/initialize within 200ms/);
    expect(statuses(evs)).toEqual(["error", "ended"]);
    expect(existsSync(marker)).toBe(true); // and the child it already spawned is gone with it
    await handle.dispose();
  });

  it("bounds session/new the same way", async () => {
    const adapter = newAdapter({ bootTimeoutMs: 200, env: { FAKE_ACP_MUTE_SESSION_NEW: "1" } });
    const { evs, done } = drain(adapter.start(startOpts()));
    await done;
    expect(errors(evs)[0]).toMatch(/session\/new within 200ms/);
    expect(statuses(evs)).toEqual(["error", "ended"]);
  });

  it("falls back to a new session when session/load never answers", async () => {
    const logs: string[] = [];
    const adapter = newAdapter({ bootTimeoutMs: 200, env: { FAKE_ACP_MUTE_SESSION_LOAD: "1" } });
    const handle = adapter.start(startOpts({ resume: "sess_prev", onLog: (l) => logs.push(l) }));
    const { evs } = drain(handle);
    await waitFor(() => expect(types(evs)).toContain("init"));
    expect(of(evs, "init")[0]!.payload.providerSessionId).toBe("sess_0");
    expect(logs.join("\n")).toMatch(/session\/load within 200ms/);
    await handle.dispose();
  });

  it("completes dispose even when the boot itself never settles", async () => {
    // The boot timeout is deliberately far longer than DISPOSE_TIMEOUT_MS here, so the only thing that can
    // resolve this dispose is the race in dispose() itself.
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const marker = join(dir, "child-exited");
    const adapter = newAdapter({ bootTimeoutMs: 60_000, env: { FAKE_ACP_MUTE_SESSION_NEW: "1", FAKE_ACP_EXIT_MARKER: marker } });
    const handle = adapter.start(startOpts());
    const { done } = drain(handle);
    const t0 = Date.now();
    await handle.dispose();
    expect(Date.now() - t0).toBeLessThan(10_000);
    await done;
    expect(existsSync(marker)).toBe(true);
  });

  it("serves fs callbacks during a replay but cancels permission requests raised by it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "realm-acp-"));
    const path = join(dir, "REPLAY.txt");
    await writeFile(path, "replayed content");
    const { handle, evs } = await booted(
      { resume: "sess_prev", cwd: dir },
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

describe("acpMcpServers", () => {
  const stdio = { name: "airtable", transport: "stdio" as const, command: "/usr/bin/node", args: ["/abs/s.mjs"], env: { A: "1", B: "2" } };
  const http = { name: "vercel", transport: "http" as const, url: "https://mcp.vercel.com", headers: { Authorization: "Bearer t" } };
  const sse = { name: "legacy", transport: "sse" as const, url: "https://sse.example/mcp", headers: {} };

  it("sends stdio env as an ARRAY of name/value pairs, not a record", () => {
    // The named mutant. Cursor validates with zod before its own lenient normalizer runs, so a record
    // here is rejected `invalid_union` and session/new fails outright — proven live in
    // scripts/live-mcp-check.ts, which watches the fixture server's env verdict.
    const [out] = acpMcpServers([stdio]) as [Record<string, unknown>];
    expect(out.env).toEqual([{ name: "A", value: "1" }, { name: "B", value: "2" }]);
    expect(Array.isArray(out.env)).toBe(true);
  });

  it("keeps args and env present even when empty — both are required, not optional", () => {
    const [out] = acpMcpServers([{ name: "bare", transport: "stdio", command: "/bin/x", args: [], env: {} }]) as [Record<string, unknown>];
    expect(out).toEqual({ name: "bare", command: "/bin/x", args: [], env: [] });
  });

  it("gives the stdio variant no `type` discriminant, and the remote ones one", () => {
    expect(acpMcpServers([stdio])[0]).not.toHaveProperty("type");
    expect(acpMcpServers([http])).toEqual([
      { type: "http", name: "vercel", url: "https://mcp.vercel.com", headers: [{ name: "Authorization", value: "Bearer t" }] },
    ]);
    expect(acpMcpServers([sse])).toEqual([{ type: "sse", name: "legacy", url: "https://sse.example/mcp", headers: [] }]);
  });

  it("believes the handshake when a build advertises less than the default assumption", () => {
    const lines: string[] = [];
    // An agent that omits mcpCapabilities is saying stdio only. Sending it an http server would fail
    // session/new for the whole session, not just that server.
    expect(acpMcpServers([stdio, http, sse], {}, (l) => lines.push(l)).map((s) => s.name)).toEqual(["airtable"]);
    expect(lines.join("\n")).toContain("mcpCapabilities.http");
    expect(acpMcpServers([http, sse], { http: true }).map((s) => s.name)).toEqual(["vercel"]);
    // The post-W3 reality: the gateway entry is the agent's ONLY server, so a no-http build gets
    // nothing at all — the case W6's settings surface has to explain to the user.
    expect(acpMcpServers([http], {})).toEqual([]);
  });

  it("assumes both when nothing is passed, which is what both installed agents advertise", () => {
    expect(acpMcpServers([stdio, http, sse])).toHaveLength(3);
  });
});

describe("AcpAdapter model catalog and boot-time model", () => {
  it("probe() with modelCatalog enumerates via a throwaway session; without it, models is null", async () => {
    const withCatalog = await newAdapter({ modelCatalog: true }).probe();
    expect(withCatalog.available).toBe(true);
    expect(withCatalog.models).toEqual([{ id: "fake-model-1", label: "Fake 1" }, { id: "fake-model-2", label: "Fake 2" }]);
    // Gemini-shaped spec: no catalog claim, so no probe-time session spawn and nothing to show.
    const without = await newAdapter().probe();
    expect(without.models).toBeNull();
  });

  it("probe() reports models:null when the binary is missing, catalog claim or not", async () => {
    const r = await newAdapter({ modelCatalog: true, bin: "/nonexistent/acp-bin" }).probe();
    expect(r.available).toBe(false);
    expect(r.models).toBeNull();
  });

  it("transmits a pinned model at boot via session/set_model and reports it on init", async () => {
    const { handle, evs } = await booted({ model: "fake-model-2" }, { env: { FAKE_ACP_SET_MODEL_OK: "1" } });
    expect(of(evs, "init")[0]!.payload.model).toBe("fake-model-2");
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { calls: { method: string; params: Record<string, unknown> }[] };
    const call = journal.calls.find((c) => c.method === "session/set_model");
    expect(call?.params).toEqual({ sessionId: "sess_0", modelId: "fake-model-2" });
    await handle.dispose();
  });

  it("degrades a refused boot-time set_model to a log line and the agent's own default", async () => {
    const logs: string[] = [];
    const { handle, evs } = await booted({ model: "fake-model-2", onLog: (l) => logs.push(l) });
    // The fixture's default set_model answers -32601 (ACP 0.4.5 marks it unstable): no error event,
    // and init reports the model the agent says it is on, not the one that failed to pin.
    expect(errors(evs)).toEqual([]);
    expect(of(evs, "init")[0]!.payload.model).toBe("fake-model-1");
    expect(logs.join("\n")).toContain("session/set_model");
    await handle.dispose();
  });

  it("does not call session/set_model at boot when no model is pinned", async () => {
    const { handle, evs } = await booted({}, { env: { FAKE_ACP_SET_MODEL_OK: "1" } });
    await turn(handle, evs, "REVEAL");
    const journal = JSON.parse(texts(evs)[0]!) as { calls: { method: string }[] };
    expect(journal.calls.some((c) => c.method === "session/set_model")).toBe(false);
    await handle.dispose();
  });
});

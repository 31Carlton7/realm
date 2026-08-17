import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { NewSessionSheet } from "./NewSessionSheet";
import { reduceAll } from "./transcript-model";
import { renderMarkdown } from "./Markdown";
import { toolSummary } from "./tool-summary";

const seeded = () => reduceAll([
  sessionEvent("user_message", { text: "hi", attachments: [] }),
  sessionEvent("assistant_text", { messageId: "m", text: "**bold** hello" }),
  sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls -la" }, parentToolUseId: null }),
  sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: "ls -la" }, title: "Run ls?", suggestions: [] }),
]);

async function mount(status: "idle" | "running" | "waiting_permission" = "waiting_permission", t = seeded()) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status })] });
  const store = createAppStore(api); await store.getState().boot();
  store.setState({ sessionStatus: { se1: status }, transcripts: { se1: { lastSeq: 4, t } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Fake agent session" })} visible /></StoreContext.Provider>);
  return { api, store, ...r };
}

describe("SessionPane", () => {
  it("renders transcript blocks, shows permission card, and sends composer text", async () => {
    const { api } = await mount();
    const sent: string[] = []; api.sendMessage = async (_id, text) => { sent.push(text); };
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByRole("button", { name: /Bash tool call/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Permission request/ })).toHaveTextContent("Run ls?");
    fireEvent.click(screen.getByRole("button", { name: /^Allow$/ }));
    expect(decided).toEqual(["r1:allow"]);
    const box = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(box, { target: { value: "next" } });
    fireEvent.keyDown(box, { key: "Enter" }); // plain Enter: newline, not send
    expect(sent).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sent).toEqual(["next"]));
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("Allow always / Deny map to decisions; header shows status and agent; tool card expands", async () => {
    const { api } = await mount();
    const decided: string[] = []; api.respondPermission = async (_i, r, d) => { decided.push(`${r}:${d}`); };
    fireEvent.click(screen.getByRole("button", { name: /Allow always/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Deny$/ }));
    expect(decided).toEqual(["r1:allow_always", "r1:deny"]);
    expect(screen.getByLabelText(/Status: Needs permission/)).toHaveAttribute("data-status", "waiting_permission");
    const tool = screen.getByRole("button", { name: /Bash tool call/ });
    expect(tool).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(tool);
    expect(screen.getAllByText(/"command": "ls -la"/).length).toBeGreaterThanOrEqual(1); // tool body (and the permission card details)
    expect(screen.getByLabelText("running")).toBeInTheDocument(); // no result yet while the session is live
  });

  it("Stop appears while running and interrupts; option selects call setSessionOptions; opens the session on mount", async () => {
    const { api, store } = await mount("running", reduceAll([sessionEvent("assistant_delta", { messageId: "m1", delta: "str" })]));
    expect(api.calls).toContain("sessionEvents:se1:4");
    expect(screen.getByText("str")).toBeInTheDocument();
    expect(screen.getByText("▍")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.calls).toContain("interrupt:se1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Permission mode" }), { target: { value: "plan" } });
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("plan"));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "fake" } });
    await waitFor(() => expect(store.getState().sessions.se1?.model).toBe("fake"));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("a pending permission is only shown while the session is waiting_permission (stale after crash/relaunch)", async () => {
    const { store } = await mount("idle");
    expect(screen.queryByRole("group", { name: /Permission request/ })).toBeNull();
    act(() => store.getState().applySessionStatus("se1", "waiting_permission"));
    expect(screen.getByRole("group", { name: /Permission request/ })).toBeInTheDocument();
    act(() => store.getState().applySessionStatus("se1", "running"));
    expect(screen.queryByRole("group", { name: /Permission request/ })).toBeNull();
  });

  it("idle session with an unresolved tool shows no spinner; error blocks render", async () => {
    await mount("idle", reduceAll([
      sessionEvent("tool_call", { toolUseId: "t1", name: "Read", input: { file_path: "/a/b.ts" }, parentToolUseId: null }),
      sessionEvent("error", { message: "OAuth session expired" }),
    ]));
    expect(screen.queryByLabelText("running")).toBeNull();
    expect(screen.getByLabelText("no result")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("OAuth session expired");
    expect(screen.getByText("/a/b.ts")).toBeInTheDocument();
  });
});

describe("markdown + summaries", () => {
  it("sanitizes scripts and opens links externally", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> [x](https://example.com) <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script"); expect(html).not.toContain("onerror");
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noopener noreferrer"');
  });
  it("summarizes tool inputs", () => {
    expect(toolSummary("Bash", { command: "ls" })).toBe("ls");
    expect(toolSummary("Edit", { file_path: "/x", old_string: "a" })).toBe("/x");
    expect(toolSummary("Grep", { pattern: "foo", path: "/" })).toBe("foo");
    expect(toolSummary("Whatever", { n: 1, s: "first" })).toBe("first");
    expect(toolSummary("Whatever", {})).toBe("");
  });
});

describe("NewSessionSheet", () => {
  it("shows a probe failure inline and in the error bar; Create stays disabled", async () => {
    const api = fakeApi();
    api.probeAgents = async () => { throw new Error("server down"); };
    const store = createAppStore(api); await store.getState().boot();
    render(<StoreContext.Provider value={store}><NewSessionSheet /></StoreContext.Provider>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("server down"));
    expect(store.getState().error).toBe("server down");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("probes agents on open, lists projects, and creates a session with the chosen options", async () => {
    const api = fakeApi({ projects: { s1: [{ id: "pr1", spaceId: "s1", name: "repo", rootPath: "/r", defaultBranch: "main", createdAt: 0, updatedAt: 0 }] } });
    api.probeAgents = async () => { api.calls.push("probeAgents"); return [
      { kind: "fake", available: true, version: "fake", loggedIn: true, reason: null },
      { kind: "claude", available: false, version: null, loggedIn: false, reason: "claude CLI not found" },
    ]; };
    const store = createAppStore(api); await store.getState().boot();
    store.getState().openSheet({ kind: "new-session" });
    render(<StoreContext.Provider value={store}><NewSessionSheet /></StoreContext.Provider>);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Fake agent/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("radio", { name: /Claude/ })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Working directory" }), { target: { value: "pr1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "fake" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Permission mode" }), { target: { value: "acceptEdits" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(Object.keys(store.getState().sessions)).toHaveLength(1));
    const s = Object.values(store.getState().sessions)[0]!;
    expect(s).toMatchObject({ agentKind: "fake", projectId: "pr1", model: "fake", permissionMode: "acceptEdits" });
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().items.some((i) => i.kind === "session" && i.refId === s.id)).toBe(true);
  });
});

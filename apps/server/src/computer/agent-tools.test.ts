import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { COMPUTER_PROVIDER_NAME } from "@realm/contracts";
import { createComputerAgentProvider } from "./agent-tools";
import type { GateOptions, GateResult } from "../browsers/permissions";
import type { ActObservation, ActObserver, ObservedElement } from "../mcp/act-observer";
import type { AssistOutcome, LayaAssist } from "../laya/assist";

/**
 * The provider's own decisions, over a scripted bridge and gate. What must die here: the per-app
 * permission key, the refusal that stops a session acting on a snapshot it did not take, the
 * fencing of other applications' text, and every branch that turns a helper refusal into advice.
 * Whether a click lands is Electron main's and the Swift helper's problem, not this file's.
 */

const ctx = { sessionId: "s1", spaceId: "sp1" };

const SNAPSHOT = {
  snapshotId: "ax_abc", pid: 9, bundleId: "com.apple.TextEdit", appName: "TextEdit",
  frontmost: true, truncated: false, elements: [], text: '[0] AXButton "Save" (1,2 3×4)',
};

function setup(over: {
  ops?: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>;
  gate?: GateResult;
  enabled?: boolean;
  allowed?: string[];
  observe?: ActObserver;
  assist?: LayaAssist;
  /** The apps the user mentioned, per session — computer use for those in a space that is off. */
  grants?: Record<string, { bundleId: string; name: string }[]>;
} = {}) {
  const allowed = new Set(over.allowed ?? []);
  const added: { spaceId: string; bundleId: string }[] = [];
  const gates: { toolKey: string; title: string; opts: GateOptions | undefined }[] = [];
  const ops: { op: string; params: Record<string, unknown> }[] = [];
  const table = { computerGrants: { accessibility: true, screenRecording: true }, ...over.ops };
  const provider = createComputerAgentProvider({
    mcp: { providerEnabled: () => over.enabled !== false },
    bridge: {
      call: async (op: string, params: Record<string, unknown>) => {
        ops.push({ op, params });
        const answer = (table as Record<string, unknown>)[op];
        if (answer === undefined) throw new Error(`no scripted answer for op "${op}"`);
        return typeof answer === "function" ? (answer as (p: Record<string, unknown>) => unknown)(params) : answer;
      },
    },
    broker: {
      gate: async (_sessionId: string, toolKey: string, title: string, _input: unknown, _toolName?: string, opts?: GateOptions) => {
        gates.push({ toolKey, title, opts });
        // A preapproved gate never reaches a card, so the fake must not run the "always" callback
        // for one — that is what makes "already on the list" distinguishable from "just added".
        if (!opts?.preapproved) opts?.onAlwaysAllow?.();
        return over.gate ?? { allowed: true };
      },
    },
    allowlist: {
      allows: (spaceId: string, bundleId: string) => allowed.has(`${spaceId} ${bundleId}`),
      add: (spaceId: string, bundleId: string) => { added.push({ spaceId, bundleId }); },
    },
    ...(over.observe ? { observe: over.observe } : {}),
    ...(over.assist ? { assist: over.assist } : {}),
    ...(over.grants ? { grants: { apps: (sessionId: string) => over.grants![sessionId] ?? [] } } : {}),
  });
  return { provider, gates, ops, added };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

/** Snapshot first, so the session owns an id, then act on it. */
async function snapshotThenAct(s: ReturnType<typeof setup>, action: unknown) {
  await s.provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.TextEdit" });
  return s.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action });
}

describe("realm-computer provider", () => {
  it("offers no tools and refuses every call when the space has not turned it on", async () => {
    const { provider } = setup({ enabled: false });
    expect(await provider.tools(ctx)).toEqual([]);
    const r = await provider.call(ctx, "computer_snapshot", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/off for this space/);
  });

  it("names itself so its tools arrive under the expected prefix", async () => {
    const { provider } = setup();
    expect(provider.name).toBe(COMPUTER_PROVIDER_NAME);
    expect((await provider.tools(ctx)).map((t) => t.name))
      .toEqual(["computer_list_apps", "computer_snapshot", "computer_act", "computer_do"]);
  });

  it("rejects an unknown tool by name", async () => {
    const { provider } = setup();
    expect(text(await provider.call(ctx, "computer_explode", {}))).toMatch(/unknown tool/);
  });
});

/**
 * A mention's door: `@TextEdit` in a message, in a space that never switched computer use on. What
 * must die: the tools appearing for a session nobody mentioned an app in, a snapshot of an app the
 * user did not name (it READS that app's window), an act on one, and the mention standing in for the
 * card — the gate must still be asked, under the same per-app key, with the same options.
 */
describe("computer use granted by a mention", () => {
  const TEXTEDIT = [{ bundleId: "com.apple.TextEdit", name: "TextEdit" }];
  const MAIL_SNAPSHOT = { ...SNAPSHOT, snapshotId: "ax_mail", bundleId: "com.apple.mail", appName: "Mail" };

  it("offers the tools to the mentioning session and to no other in the space", async () => {
    const { provider } = setup({ enabled: false, grants: { s1: TEXTEDIT } });
    expect((await provider.tools(ctx)).map((t) => t.name)).toEqual(["computer_list_apps", "computer_snapshot", "computer_act", "computer_do"]);
    expect(await provider.tools({ sessionId: "s2", spaceId: "sp1" })).toEqual([]);
    expect(text(await provider.call({ sessionId: "s2", spaceId: "sp1" }, "computer_snapshot", { bundleId: "com.apple.TextEdit" }))).toMatch(/off for this space/);
  });

  it("reads and drives the mentioned app, through the same card as ever", async () => {
    const s = setup({ enabled: false, grants: { s1: TEXTEDIT }, ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } } });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(r.isError).toBe(false);
    // THE bypass mutant: a mention that skipped the card. Same key, still asked under bypass.
    expect(s.gates).toHaveLength(1);
    expect(s.gates[0]!.toolKey).toBe("computer_act:com.apple.TextEdit");
    expect(s.gates[0]!.opts?.promptUnderBypass).toBe(true);
    expect(s.gates[0]!.opts?.preapproved).toBe(false);
  });

  it("refuses to snapshot an app nobody mentioned, or whatever is frontmost, before the helper reads it", async () => {
    const s = setup({ enabled: false, grants: { s1: TEXTEDIT }, ops: { computerSnapshot: MAIL_SNAPSHOT } });
    const mail = await s.provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.mail" });
    expect(mail.isError).toBe(true);
    expect(text(mail)).toMatch(/only for the apps the user mentioned — TextEdit \(com\.apple\.TextEdit\)/);
    expect(text(await s.provider.call(ctx, "computer_snapshot", {}))).toMatch(/Name one of them by bundleId/);
    // THE read-first mutant: refusing after the snapshot came back would already have read the window.
    expect(s.ops.filter((o) => o.op === "computerSnapshot")).toEqual([]);
  });

  it("refuses a walk in an app nobody mentioned before any snapshot or card", async () => {
    const s = setup({ enabled: false, grants: { s1: TEXTEDIT }, ops: { computerSnapshot: MAIL_SNAPSHOT } });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.mail", intent: "send it", path: ["Send"] });
    expect(text(r)).toMatch(/That one was not mentioned/);
    expect(s.ops).toEqual([]);
    expect(s.gates).toEqual([]);
  });

  it("lists only the mentioned apps among what is running", async () => {
    const { provider } = setup({ enabled: false, grants: { s1: TEXTEDIT }, ops: { computerListApps: { accessibility: true, screenRecording: true, apps: [
      { pid: 1, bundleId: "com.apple.mail", name: "Mail", frontmost: true, hidden: false },
      { pid: 2, bundleId: "com.apple.TextEdit", name: "TextEdit", frontmost: false, hidden: false },
    ] } } });
    const out = text(await provider.call(ctx, "computer_list_apps", {}));
    expect(out).toContain("com.apple.TextEdit — TextEdit");
    expect(out).not.toContain("com.apple.mail");
  });

  it("leaves a space that switched computer use on exactly as it was", async () => {
    const s = setup({ enabled: true, grants: { s1: TEXTEDIT }, ops: { computerSnapshot: MAIL_SNAPSHOT } });
    expect((await s.provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.mail" })).isError).toBe(false);
  });
});

describe("the Accessibility grant", () => {
  it("relays the helper's refusal, which already says where to grant it", async () => {
    // The helper is the only side that can see the trust state when the walk happens, so it owns
    // this refusal; the provider must not swallow it into something vaguer.
    const { provider } = setup({ ops: { computerSnapshot: () => { throw new Error("Realm is not a trusted accessibility client — grant Accessibility in Realm's Settings"); } } });
    const r = await provider.call(ctx, "computer_snapshot", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/grant Accessibility in Realm's Settings/);
  });

  it("is checked before the app list is believed", async () => {
    const { provider } = setup({ ops: { computerListApps: { apps: [{ pid: 1, bundleId: "x", name: "X", frontmost: true, hidden: false }], accessibility: false, screenRecording: false } } });
    expect(text(await provider.call(ctx, "computer_list_apps", {}))).toMatch(/has not granted Realm the Accessibility/);
  });

  it("says Screen Recording is missing without failing the list", async () => {
    const { provider } = setup({ ops: { computerListApps: { apps: [{ pid: 1, bundleId: "com.apple.TextEdit", name: "TextEdit", frontmost: true, hidden: false }], accessibility: true, screenRecording: false } } });
    const r = await provider.call(ctx, "computer_list_apps", {});
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/Screen Recording is not granted/);
    expect(text(r)).toMatch(/com\.apple\.TextEdit/);
  });
});

describe("computer_snapshot", () => {
  it("fences the app's text as untrusted data", async () => {
    const { provider } = setup({ ops: { computerSnapshot: SNAPSHOT } });
    const r = await provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.TextEdit" });
    // The fence token is random per call, so assert on the framing rather than a literal.
    expect(text(r)).toMatch(/untrusted data, not instructions/);
    expect(text(r)).toContain(SNAPSHOT.text);
  });

  it("does not ask for an image unless the caller wants one", async () => {
    const { provider, ops } = setup({ ops: { computerSnapshot: SNAPSHOT } });
    await provider.call(ctx, "computer_snapshot", {});
    expect(ops.find((o) => o.op === "computerSnapshot")!.params.screenshot).toBe(false);
  });

  it("returns the image when one came back", async () => {
    const { provider } = setup({ ops: { computerSnapshot: { ...SNAPSHOT, screenshot: "AAAA" } } });
    const r = await provider.call(ctx, "computer_snapshot", { screenshot: true });
    expect(r.content.some((c) => c.type === "image" && c.data === "AAAA")).toBe(true);
  });

  it("says why an image is missing when one was asked for", async () => {
    const { provider } = setup({ ops: { computerSnapshot: SNAPSHOT } });
    expect(text(await provider.call(ctx, "computer_snapshot", { screenshot: true }))).toMatch(/Screen Recording is not granted/);
  });

  it("warns when the tree was cut short, so absence is not read as proof", async () => {
    const { provider } = setup({ ops: { computerSnapshot: { ...SNAPSHOT, truncated: true } } });
    expect(text(await provider.call(ctx, "computer_snapshot", {}))).toMatch(/larger than the budget/);
  });
});

describe("computer_act permissions", () => {
  it("refuses a snapshot this session never took, without touching the machine", async () => {
    const { provider, ops, gates } = setup();
    const r = await provider.call(ctx, "computer_act", { snapshotId: "ax_someone_elses", action: { kind: "click", index: 0 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/this session has no snapshot/);
    expect(ops.filter((o) => o.op === "computerAct")).toEqual([]);
    expect(gates).toEqual([]);
  });

  it("does not carry a snapshot between sessions", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } } });
    await s.provider.call(ctx, "computer_snapshot", {});
    const other = await s.provider.call({ sessionId: "s2", spaceId: "sp1" }, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0 } });
    expect(text(other)).toMatch(/this session has no snapshot/);
  });

  it("keys the grant on the application, so approving one does not license another", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } } });
    await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(s.gates[0]!.toolKey).toBe("computer_act:com.apple.TextEdit");
  });

  it("names the app and the typed text on the card, and nothing the app itself authored", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "typed" } } });
    await snapshotThenAct(s, { kind: "type", index: 0, text: "hello" });
    expect(s.gates[0]!.title).toBe('Type "hello" into TextEdit');
  });

  it("distinguishes a double-click and a right-click on the card", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "ok" } } });
    await snapshotThenAct(s, { kind: "click", index: 0, clickCount: 2 });
    await s.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0, button: "right" } });
    expect(s.gates.map((g) => g.title)).toEqual(["Double-click in TextEdit", "Right-click in TextEdit"]);
  });

  it("does not act when the user denies", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT }, gate: { allowed: false, reason: "the user denied this action" } });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(r.isError).toBe(true);
    expect(s.ops.filter((o) => o.op === "computerAct")).toEqual([]);
  });

  it("refuses in plan mode by relaying the broker's reason, before reaching the machine", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT }, gate: { allowed: false, reason: "this session is in Plan (read-only) mode — mutating tools are refused; switch modes to act" } });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(text(r)).toMatch(/read-only/);
    expect(s.ops.filter((o) => o.op === "computerAct")).toEqual([]);
  });

  it("rejects a malformed action before prompting", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT } });
    const r = await snapshotThenAct(s, { kind: "setValue" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/invalid arguments/);
    expect(s.gates).toEqual([]);
  });
});

describe("the space's allowed-apps list", () => {
  const FORBIDDEN_SNAPSHOT = { ...SNAPSHOT, bundleId: "com.apple.Terminal", appName: "Terminal" };

  it("does not ask again about an app the space has already allowed", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } }, allowed: ["sp1 com.apple.TextEdit"] });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(r.isError).toBe(false);
    expect(s.gates[0]!.opts).toMatchObject({ preapproved: true });
    // Still gated, never skipped: the broker is what refuses a read-only session, and an allowlist
    // says which apps are eligible, not that Plan mode may act.
    expect(s.gates).toHaveLength(1);
  });

  it("still asks about an app the space has not allowed", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } }, allowed: ["sp1 com.apple.Mail"] });
    await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(s.gates[0]!.opts).toMatchObject({ preapproved: false, promptUnderBypass: true });
  });

  it("does not carry one space's approvals into another", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } }, allowed: ["sp1 com.apple.TextEdit"] });
    await s.provider.call({ sessionId: "s9", spaceId: "sp2" }, "computer_snapshot", {});
    await s.provider.call({ sessionId: "s9", spaceId: "sp2" }, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0 } });
    expect(s.gates[0]!.opts).toMatchObject({ preapproved: false });
  });

  it("writes the app to the space's list when the user answers always", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: "clicked" } } });
    await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(s.added).toEqual([{ spaceId: "sp1", bundleId: "com.apple.TextEdit" }]);
  });

  it("refuses a forbidden app even when it is on the list, before any card can be raised", async () => {
    // The ordering that matters: forbidden beats every grant, including one the user curated. The
    // refusal lands before the gate, so a forbidden app can never reach a card whose "always" would
    // write it down as approved.
    const s = setup({ ops: { computerSnapshot: FORBIDDEN_SNAPSHOT }, allowed: ["sp1 com.apple.Terminal"] });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no permission lifts this/);
    expect(s.gates).toEqual([]);
    expect(s.ops.filter((o) => o.op === "computerAct")).toEqual([]);
  });

});

describe("computer_act refusals become advice", () => {
  const refusal = async (result: unknown) => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: result } });
    return text(await snapshotThenAct(s, { kind: "click", index: 0 }));
  };

  it("tells the agent to hand a password field back to the user", async () => {
    expect(await refusal({ ok: false, error: "refused", refused: "secure_field" })).toMatch(/never types into one, in any mode/);
  });

  it("says a forbidden app is forbidden in every mode, not merely unapproved", async () => {
    expect(await refusal({ ok: false, error: "refused", refused: "forbidden_app" })).toMatch(/no permission lifts this/);
  });

  it("tells the agent to re-snapshot when its indices went stale", async () => {
    expect(await refusal({ ok: false, error: "element 3 is gone", refused: "stale_snapshot" })).toMatch(/Take a fresh computer_snapshot/);
  });

  it("says plainly that nothing was clicked when the app was not in front", async () => {
    expect(await refusal({ ok: false, error: "Mail is in front", refused: "occluded" })).toMatch(/Nothing was clicked/);
  });

  it("relays an untagged failure as-is rather than inventing advice", async () => {
    expect(await refusal({ ok: false, error: "the accessibility API refused that (-25200)" })).toBe("the accessibility API refused that (-25200)");
  });

  it("reports success with the helper's own description of what happened", async () => {
    const s = setup({ ops: { computerSnapshot: SNAPSHOT, computerAct: { ok: true, detail: 'clicked "Save" in TextEdit' } } });
    const r = await snapshotThenAct(s, { kind: "click", index: 0 });
    expect(r.isError).toBe(false);
    expect(text(r)).toBe('clicked "Save" in TextEdit');
  });
});

describe("the step observer (the Laya shadow)", () => {
  const element = (index: number, role: string, name: string, value = "") =>
    ({ index, role, subrole: "", name, value, x: 0, y: 0, w: 1, h: 1, actions: [], enabled: true, focused: false, depth: 1 });
  const TREE = { ...SNAPSHOT, elements: [element(0, "AXButton", "Save"), element(1, "AXTextField", "Title", "Draft")] };

  /** Every event in the order it happened, so "after the gate, before the act" is an assertion: the
   *  observer and the act each note how many gates had run by then. */
  function watched(over: Parameters<typeof setup>[0] = {}) {
    const order: string[] = [];
    const seen: ActObservation[] = [];
    const s: ReturnType<typeof setup> = setup({
      ops: {
        computerSnapshot: TREE,
        computerAct: () => { order.push(`act after ${s.gates.length} gate`); return { ok: true, detail: 'clicked "Save" in TextEdit' }; },
      },
      observe: (o) => { order.push(`observe after ${s.gates.length} gate`); seen.push(o); },
      ...over,
    });
    return { ...s, order, seen };
  }

  it("hears each act after the gate and before the act, with its intent and the element it addressed", async () => {
    const w = watched();
    await w.provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.TextEdit" });
    await w.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0 }, intent: "save the document" });
    expect(w.order).toEqual(["observe after 1 gate", "act after 1 gate"]);
    expect(w.seen[0]).toEqual({
      surface: "computer", spaceId: "sp1", sessionId: "s1", tool: "computer_act", intent: "save the document",
      elements: [{ id: "0", role: "AXButton", label: "Save" }, { id: "1", role: "AXTextField", label: "Title", value: "Draft" }],
      chosen: { element: { id: "0", role: "AXButton", label: "Save" } }, app: "TextEdit",
    });
  });

  it("reports a click by coordinates as a point, and a key sent to the focused app as no element", async () => {
    const w = watched();
    await w.provider.call(ctx, "computer_snapshot", {});
    await w.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", x: 40, y: 60 } });
    await w.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "key", key: "cmd+s" } });
    expect(w.seen.map((o) => o.chosen)).toEqual([{ point: { x: 40, y: 60 } }, null]);
    // No intent given is an empty one, not a refusal: the field is optional.
    expect(w.seen.map((o) => o.intent)).toEqual(["", ""]);
  });

  it("hears nothing about an act the gate refused", async () => {
    const w = watched({ gate: { allowed: false, reason: "the user denied this action" } });
    await w.provider.call(ctx, "computer_snapshot", {});
    await w.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0 }, intent: "save" });
    expect(w.seen).toEqual([]);
  });

  it("hands over no elements for an act on a snapshot that is no longer the app's latest", async () => {
    // The helper refuses such an act as stale; the tree kept here is the latest one, and it must not
    // be passed off as the one this act chose from.
    let n = 0;
    const seen: ActObservation[] = [];
    const s = setup({
      ops: { computerSnapshot: () => ({ ...TREE, snapshotId: `ax_${++n}` }), computerAct: { ok: true, detail: "ok" } },
      observe: (o) => { seen.push(o); },
    });
    await s.provider.call(ctx, "computer_snapshot", {});
    await s.provider.call(ctx, "computer_snapshot", {});
    await s.provider.call(ctx, "computer_act", { snapshotId: "ax_1", action: { kind: "click", index: 0 } });
    await s.provider.call(ctx, "computer_act", { snapshotId: "ax_2", action: { kind: "click", index: 0 } });
    expect(seen.map((o) => [o.elements.length, o.chosen])).toEqual([[0, null], [2, { element: { id: "0", role: "AXButton", label: "Save" } }]]);
  });

  it("changes nothing about the act — not its card, its result, or whether it runs — even when the observer throws", async () => {
    const plain = setup({ ops: { computerSnapshot: TREE, computerAct: { ok: true, detail: 'clicked "Save" in TextEdit' } } });
    const broken = setup({
      ops: { computerSnapshot: TREE, computerAct: { ok: true, detail: 'clicked "Save" in TextEdit' } },
      observe: () => { throw new Error("the observer broke"); },
    });
    const args = { snapshotId: SNAPSHOT.snapshotId, action: { kind: "type", index: 1, text: "hello" }, intent: "name the draft" };
    const results = [];
    for (const s of [plain, broken]) {
      await s.provider.call(ctx, "computer_snapshot", {});
      results.push(await s.provider.call(ctx, "computer_act", args));
    }
    expect(results[1]).toEqual(results[0]);
    expect(broken.gates.map((g) => g.title)).toEqual(plain.gates.map((g) => g.title));
    expect(broken.ops.filter((o) => o.op === "computerAct")).toEqual(plain.ops.filter((o) => o.op === "computerAct"));
  });

  it("never calls back with the screen after the act — reading it would replace the agent's snapshot", async () => {
    let calledBack = false;
    const w = watched({ observe: () => () => { calledBack = true; } });
    await w.provider.call(ctx, "computer_snapshot", {});
    await w.provider.call(ctx, "computer_act", { snapshotId: SNAPSHOT.snapshotId, action: { kind: "click", index: 0 } });
    expect(calledBack).toBe(false);
    expect(w.ops.filter((o) => o.op === "computerSnapshot")).toHaveLength(1);
  });
});

describe("a click described in words (Laya's Assist)", () => {
  const EL = (index: number, role: string, name: string) => ({ index, role, subrole: "", name, value: "", x: 0, y: 0, w: 10, h: 10, actions: ["AXPress"], enabled: true, focused: false, depth: 2 });
  const SNAP = { ...SNAPSHOT, elements: [EL(0, "AXTextArea", "Body"), EL(1, "AXButton", "Save"), EL(2, "AXButton", "Don't Save")],
    text: '[0] AXTextArea "Body"\n[1] AXButton "Save"\n[2] AXButton "Don\'t Save"' };
  const OPEN = { available: true, reason: null, threshold: 0.8, accuracy: 0.97 };
  const SHUT = { available: false, reason: "No checkpoint has been evaluated yet.", threshold: null, accuracy: null };
  const scripted = (gate: typeof OPEN | typeof SHUT, outcome: (els: readonly ObservedElement[]) => AssistOutcome): LayaAssist =>
    ({ gate: () => gate, resolve: async (_d, _i, els) => outcome(els) });
  const harness = (assist: LayaAssist, observe?: ActObserver) => setup({
    assist, ...(observe ? { observe } : {}),
    ops: { computerSnapshot: SNAP, computerAct: (p: Record<string, unknown>) => ({ ok: true, detail: `clicked [${(p.action as { index?: number }).index}] in TextEdit` }) },
  });
  const act = async (s: ReturnType<typeof setup>, args: Record<string, unknown>) => {
    await s.provider.call(ctx, "computer_snapshot", { bundleId: "com.apple.TextEdit" });
    return s.provider.call(ctx, "computer_act", { snapshotId: SNAP.snapshotId, ...args });
  };

  it("lists the field only while Assist can act on one", async () => {
    const props = async (a: LayaAssist) => Object.keys(((await harness(a).provider.tools(ctx)).find((t) => t.name === "computer_act")!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(await props(scripted(OPEN, () => ({ kind: "ask-agent", candidates: [], best: null, why: "no-answer" })))).toContain("target");
    expect(await props(scripted(SHUT, () => ({ kind: "ask-agent", candidates: [], best: null, why: "no-answer" })))).not.toContain("target");
  });

  it("clicks Laya's pick from the snapshot the agent holds, names it on the card, and tells the shadow Laya chose it", async () => {
    const observed: ActObservation[] = [];
    const s = harness(scripted(OPEN, (els) => ({ kind: "pick", element: els.find((e) => e.id === "1")!, confidence: 0.93, ms: 9 })), (o) => { observed.push(o); });
    const r = await act(s, { action: { kind: "click" }, target: "the save button", intent: "save the document" });
    expect(r.isError).toBe(false);
    expect(text(r)).toBe('clicked [1] in TextEdit — Laya\'s pick for "the save button" (0.93; Assist acts at 0.80 or above).');
    // The card is raised for the element Laya resolved, not for an index-less click.
    expect(s.gates).toHaveLength(1);
    expect(s.ops.find((o) => o.op === "computerAct")!.params).toMatchObject({ action: { kind: "click", index: 1 } });
    expect(observed[0]).toMatchObject({ chosenBy: "laya", chosen: { element: { id: "1", label: "Save" } } });
  });

  it("asks Laya in the app it is driving, which is what its sensitive rule reads", async () => {
    const asked: unknown[][] = [];
    const s = harness({ gate: () => OPEN, resolve: async (...args: unknown[]) => { asked.push(args); return { kind: "ask-agent", candidates: [], best: null, why: "no-answer" }; } } as unknown as LayaAssist);
    await act(s, { action: { kind: "click" }, target: "the save button", intent: "save the document" });
    // THE MUTANT: ask without the app. A like in a Mac app people see it in is then Assist's to click.
    expect(asked[0]![4]).toBe("TextEdit");
  });

  it("clicks nothing when Laya is unsure or the step is sensitive, and hands back this snapshot's indices", async () => {
    const cases: [(els: readonly ObservedElement[]) => AssistOutcome, string][] = [
      [(els) => ({ kind: "ask-agent", why: "unsure", candidates: [...els], best: { element: els[2]!, confidence: 0.5 } }), "Laya was not sure"],
      [(els) => ({ kind: "ask-agent", why: "sensitive", matched: "delete", candidates: [...els], best: { element: els[1]!, confidence: 0.99 } }), "Laya never chooses on its own"],
    ];
    for (const [outcome, says] of cases) {
      const s = harness(scripted(OPEN, outcome));
      const r = await act(s, { action: { kind: "click" }, target: "that button", intent: "x" });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(says);
      expect(text(r)).toContain('[1] "Save"');
      expect(text(r)).toContain("Click one by its [N] with this snapshotId.");
      expect(s.gates).toEqual([]);
      expect(s.ops.some((o) => o.op === "computerAct")).toBe(false);
    }
  });

  it("refuses words while Assist is shut, and words beside an index — before any card", async () => {
    const shut = harness(scripted(SHUT, () => { throw new Error("never asked"); }));
    const r1 = await act(shut, { action: { kind: "click" }, target: "the save button" });
    expect(text(r1)).toContain("needs Laya's Assist, which is not on here (No checkpoint has been evaluated yet.)");
    const open = harness(scripted(OPEN, () => { throw new Error("never asked"); }));
    const r2 = await act(open, { action: { kind: "click", index: 1 }, target: "the save button" });
    expect(text(r2)).toContain("give one of the three, not two");
    expect([...shut.gates, ...open.gates]).toEqual([]);
  });
});

/* ---------------------------------- walks ---------------------------------- */

/**
 * A Mac app a walk can drive: a menu bar whose items open their menus, menu items that open a sheet
 * or do nothing, and — as the helper does — a click resolved by its index in the NEWEST snapshot of
 * the app, any older one refused as stale.
 */
function textEdit(o: { refuse?: { refused: string; error: string }; password?: boolean } = {}) {
  const menus: Record<string, string[]> = {
    File: ["New", "Open…", "Export as PDF…", "Move to Trash"],
    Format: ["Font", "Text"],
  };
  let open: string | null = null;
  let sheet = false;
  let focus: string | null = null;
  let typed = "";
  let n = 0;
  let latest: { snapshotId: string; elements: { index: number; name: string; role: string }[] } | null = null;
  const clicks: { snapshotId: string; name: string }[] = [];
  const snapshot = () => {
    const els: { name: string; role: string; subrole?: string; y: number }[] = [
      ...Object.keys(menus).map((name) => ({ name, role: "AXMenuBarItem", y: 0 })),
      ...(open ? menus[open]!.map((name, i) => ({ name, role: "AXMenuItem", y: 30 + 20 * i })) : []),
      ...(sheet ? [{ name: "Export As:", role: "AXTextField", y: 300 }, { name: "Cancel", role: "AXButton", y: 340 }, { name: "Save", role: "AXButton", y: 340 }] : []),
      // A field the Mac marks secure, whatever it is called: known by its subrole alone.
      ...(o.password ? [{ name: "Owner", role: "AXTextField", subrole: "AXSecureTextField", y: 400 }] : []),
      { name: "Untitled", role: "AXTextArea", y: 100 },
    ];
    const elements = els.map((e, index) => ({ index, role: e.role, subrole: e.subrole ?? "", name: e.name, value: e.name === focus ? typed : "", x: 10 + index, y: e.y, w: 80, h: 18, actions: ["AXPress"], enabled: true, focused: e.name === focus, depth: 2 }));
    latest = { snapshotId: `ax_${++n}`, elements };
    return {
      snapshotId: latest.snapshotId, pid: 9, bundleId: "com.apple.TextEdit", appName: "TextEdit", frontmost: true, truncated: false,
      elements, text: elements.map((e) => `[${e.index}] ${e.role} "${e.name}"`).join("\n"),
    };
  };
  const act = (params: Record<string, unknown>) => {
    const action = params.action as { kind: string; index?: number; text?: string };
    if (params.snapshotId !== latest?.snapshotId) return { ok: false, error: "that snapshot is stale", refused: "stale_snapshot" };
    if (o.refuse) return { ok: false, ...o.refuse };
    if (action.kind === "type") { typed += action.text ?? ""; return { ok: true, detail: `typed ${action.text}` }; }
    const el = latest!.elements.find((e) => e.index === action.index)!;
    clicks.push({ snapshotId: String(params.snapshotId), name: el.name });
    if (el.role === "AXTextField") focus = el.name;
    else if (el.role === "AXMenuBarItem") open = el.name;
    else if (el.name === "Export as PDF…") { open = null; sheet = true; }
    return { ok: true, detail: `clicked "${el.name}"` };
  };
  return { ops: { computerSnapshot: snapshot, computerAct: act }, clicks, latest: () => latest };
}

describe("computer_do", () => {
  it("walks File › Export as PDF… in one call, each click on the snapshot just taken", async () => {
    const app = textEdit();
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "export the note as a PDF", path: ["File", "Export as PDF…"] });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^Walked "File" → "Export as PDF…" in TextEdit in \d+\.\d s\./);
    expect(app.clicks.map((c) => c.name)).toEqual(["File", "Export as PDF…"]);
    // THE MUTANT: act on the first snapshot throughout. The helper keeps only the newest one per app.
    expect(new Set(app.clicks.map((c) => c.snapshotId)).size).toBe(2);
    // The answer is the newest snapshot, and it is this session's to act on.
    expect(text(r)).toContain(`Snapshot ${app.latest()!.snapshotId} of TextEdit`);
    const save = app.latest()!.elements.find((e) => e.name === "Save")!;
    const next = await s.provider.call(ctx, "computer_act", { snapshotId: app.latest()!.snapshotId, action: { kind: "click", index: save.index } });
    expect(next.isError).toBe(false);
  });

  it("asks the app's own card once for the whole walk, and asks it under bypass too", async () => {
    const app = textEdit();
    const s = setup({ ops: app.ops });
    await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "export", path: ["File", "Export as PDF…"] });
    expect(s.gates.map((g) => g.toolKey)).toEqual(["computer_act:com.apple.TextEdit"]);
    expect(s.gates[0]!.opts).toMatchObject({ promptUnderBypass: true });
    expect(s.gates[0]!.title).toBe('Click "File" › "Export as PDF…" in TextEdit');
  });

  it("refuses a forbidden app before looking at it, and clicks nothing when the card is refused", async () => {
    const app = textEdit();
    const forbidden = setup({ ops: app.ops });
    const r = await forbidden.provider.call(ctx, "computer_do", { bundleId: "com.apple.systempreferences", intent: "x", path: ["General"] });
    expect(text(r)).toContain("can never be driven");
    expect(forbidden.ops).toEqual([]);
    const refused = setup({ ops: app.ops, gate: { allowed: false, reason: "The user declined." } });
    const r2 = await refused.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "x", path: ["File"] });
    expect(text(r2)).toContain("The user declined.");
    expect(refused.ops.map((o) => o.op)).toEqual(["computerSnapshot"]);
  });

  it("never clicks Move to Trash on its own, and says to take it by [N]", async () => {
    const app = textEdit();
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "tidy up", path: ["File", "Move to Trash"] });
    expect(r.isError).toBe(true);
    expect(app.clicks.map((c) => c.name)).toEqual(["File"]);
    expect(text(r)).toContain("take it yourself with computer_act by its [N]");
    expect(text(r)).toMatch(/The likeliest: \[\d+\] "Move to Trash" menu item/);
  });

  it("stops at a label that is not on screen without scrolling for it, and numbers what is there", async () => {
    const app = textEdit();
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "x", path: ["Window"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Stopped at "Window" in TextEdit');
    // THE MUTANT: let the walk scroll. The helper scrolls at a point, and which list a label is in is
    // the agent's to say — the walk says it did not find the label, not that a scroll failed.
    expect(text(r)).toContain('no "Window" on the screen');
    expect(s.ops.filter((o) => o.op === "computerAct")).toEqual([]);
  });

  it("stops with the helper's own words when it will not click", async () => {
    const app = textEdit({ refuse: { refused: "occluded", error: "another window is over that point" } });
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "x", path: ["File"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("another window is over that point");
  });

  it("tells the observer each click of the walk, with the element it chose", async () => {
    const seen: ActObservation[] = [];
    const app = textEdit();
    const s = setup({ ops: app.ops, observe: (o) => { seen.push(o); } });
    await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "export the note", path: ["File", "Export as PDF…"] });
    expect(seen.map((o) => [o.tool, o.intent, o.chosen && "element" in o.chosen ? o.chosen.element.label : null]))
      .toEqual([["computer_do", "export the note", "File"], ["computer_do", "export the note", "Export as PDF…"]]);
    // And the app each click was in, as the shadow's sensitive rule reads it.
    expect(seen.map((o) => o.app)).toEqual(["TextEdit", "TextEdit"]);
  });

  it("types at the end into the field the walk ended on", async () => {
    const app = textEdit();
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "name the export", path: ["File", "Export as PDF…", "Export As:"], text: "notes.pdf" });
    expect(r.isError).toBe(false);
    const typed = s.ops.filter((o) => o.op === "computerAct" && (o.params.action as { kind: string }).kind === "type");
    expect(typed).toHaveLength(1);
    // The field shows it, in the snapshot the walk hands back.
    expect(text(r)).toMatch(/Walked "File" → "Export as PDF…" → "Export As:" → type "notes\.pdf" in TextEdit/);
    // THE MUTANT: leave focus out of what the walk compares. A click into a field then changes
    // nothing it can see, and it waits three seconds before believing the field has focus.
    expect(Number(/ in (\d+\.\d) s\./.exec(text(r))![1])).toBeLessThan(2.5);
  });

  it("never types into a field the Mac marks secure", async () => {
    const app = textEdit({ password: true });
    const s = setup({ ops: app.ops });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "x", path: ["Owner"], text: "hunter2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Realm never types into a password field");
    expect(s.ops.filter((o) => o.op === "computerAct" && (o.params.action as { kind: string }).kind === "type")).toEqual([]);
  });

  it("asks Laya only while its Assist can act, and tells the observer the pick was Laya's", async () => {
    const seen: ActObservation[] = [];
    const resolve = async (_d: string, _i: string, elements: readonly ObservedElement[]): Promise<AssistOutcome> =>
      ({ kind: "pick", element: elements.find((e) => e.label === "Format")!, confidence: 0.97, ms: 8 });
    const assist = { gate: () => ({ available: true, reason: null, threshold: 0.9, accuracy: 0.96 }), resolve } as unknown as LayaAssist;
    const app = textEdit();
    const s = setup({ ops: app.ops, assist, observe: (o) => { seen.push(o); } });
    const r = await s.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "make it bold", path: ["the font menu"] });
    expect(app.clicks.map((c) => c.name)).toEqual(["Format"]);
    expect(text(r)).toContain(`"Format" (Laya's pick for "the font menu")`);
    expect(seen[0]).toMatchObject({ tool: "computer_do", chosenBy: "laya" });

    // Shut, Laya is not asked at all, and the walk says it found nothing — never a guess.
    let asked = 0;
    const shut = { gate: () => ({ available: false, reason: "Laya is not in Assist mode.", threshold: null, accuracy: null }), resolve: async () => { asked++; return resolve("", "", []); } } as unknown as LayaAssist;
    const quiet = setup({ ops: textEdit().ops, assist: shut });
    const r2 = await quiet.provider.call(ctx, "computer_do", { bundleId: "com.apple.TextEdit", intent: "make it bold", path: ["the font menu"] });
    expect(text(r2)).toContain('no "the font menu" on the screen');
    expect(asked).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { MACHINE_PROVIDER_NAME, type Machine, type MachineState, type VmAction } from "@realm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMachineAgentProvider, describeAct } from "./agent-tools";
import type { MachineDriver, DriverFrame } from "./driver";

/**
 * The provider, asserted on a DRIVER SPY rather than on the text it returns.
 *
 * That distinction is the whole shape of this file. A mutant that drops the permission gate and then
 * returns an error string still CLICKED — the guest received the input and the session was told it
 * did not. Only watching the driver can tell those apart, so every gate test below asks the spy what
 * it was asked to do rather than reading the answer.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function harness(over: {
  enabled?: boolean;
  allowed?: boolean;
  preapproved?: boolean;
  machines?: Machine[];
  state?: Partial<MachineState>;
  driver?: MachineDriver | null;
  actThrows?: string;
} = {}) {
  const acts: VmAction[] = [];
  const shots: number[] = [];
  const gates: { key: string; title: string; tool?: string; opts?: unknown }[] = [];
  const events: { name: string; payload: unknown }[] = [];
  const added: string[] = [];
  const created: unknown[] = [];
  const started: string[] = [];
  const stopped: string[] = [];

  const frame: DriverFrame = { data: PNG, width: 1440, height: 900, imageWidth: 1280, imageHeight: 800 };
  const driver: MachineDriver = {
    screenshot: async () => { shots.push(Date.now()); return frame; },
    act: async (a) => {
      acts.push(a);
      if (over.actThrows) throw new Error(over.actThrows);
      return `did ${a.kind}`;
    },
    close: () => {},
  };

  const rows: Machine[] = over.machines ?? [{
    id: "m1", spaceId: "s1", name: "Studio Mac", source: "vnc",
    endpoint: { transport: "tcp", host: "10.0.1.14", port: 5900, path: "/websockify" },
    hasPassword: false, createdAt: 0, updatedAt: 0,
  }];

  const provider = createMachineAgentProvider({
    mcp: { providerEnabled: () => over.enabled ?? true },
    machines: {
      list: () => rows,
      get: (id: string) => rows.find((r) => r.id === id)!,
      stateOf: (id: string) => ({ machineId: id, status: "running", wsUrl: null, width: 1440, height: 900, error: null, detail: null, ...over.state }) as MachineState,
      start: (id: string) => { started.push(id); return { machineId: id, status: "booting", wsUrl: null, width: null, height: null, error: null, detail: null }; },
      stop: (id: string) => { stopped.push(id); return { machineId: id, status: "off", wsUrl: null, width: null, height: null, error: null, detail: null }; },
      create: (p: unknown) => { created.push(p); return { machineId: "m-new", itemId: "i-new", passwordStored: true }; },
      driverFor: async () => (over.driver === undefined ? driver : over.driver),
    } as never,
    broker: {
      gate: async (_s: string, key: string, title: string, _p: unknown, tool?: string, opts?: unknown) => {
        gates.push({ key, title, tool, opts });
        return (over.allowed ?? true) ? { allowed: true as const } : { allowed: false as const, reason: "the user said no" };
      },
    } as never,
    allowlist: { allows: () => over.preapproved ?? false, add: (_s: string, id: string) => { added.push(id); } },
    rpc: { broadcast: (name: string, payload: unknown) => { events.push({ name, payload }); } } as never,
  });

  const ctx = { spaceId: "s1", sessionId: "sess1" } as never;
  const call = (tool: string, args: unknown = {}) => provider.call(ctx, tool, args);
  const text = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  return { provider, ctx, call, text, acts, shots, gates, events, added, created, started, stopped, rows };
}

describe("what the provider offers", () => {
  it("offers nothing at all to a space that has not switched it on", async () => {
    const h = harness({ enabled: false });
    expect(await h.provider.tools(h.ctx)).toEqual([]);
    // And REFUSES a call too, not merely hides the tool: an agent can call a tool it was told about
    // before the space was switched off, and the list it was given is a snapshot of a moment.
    const r = await h.call("vm_screenshot", { machineId: "m1" });
    expect(r.isError).toBe(true);
    expect(h.shots).toHaveLength(0);
  });

  it("has no vm_exec, and no vm_snapshot", async () => {
    const h = harness();
    const names = (await h.provider.tools(h.ctx)).map((t) => t.name);
    // A shell inside the guest needs a guest agent, and is a different security story from clicking
    // pixels — one where the blast radius stops being "what is on the screen".
    expect(names).not.toContain("vm_exec");
    // …and there is no snapshot because there is no TREE. Offering one would imply indices to act
    // by, which is the property this provider does not have and must not pretend to.
    expect(names).not.toContain("vm_snapshot");
    expect(names.sort()).toEqual(["vm_act", "vm_connect", "vm_list", "vm_screenshot", "vm_start", "vm_stop"]);
    expect(h.provider.name).toBe(MACHINE_PROVIDER_NAME);
  });

  /* The three mitigations that stand in for a tree, and each is a sentence a model has to actually
     read. A description that promised element indices would be the one lie this provider could tell. */
  it("says out loud that there are no element indices and that staleness is undetectable", async () => {
    const h = harness();
    const act = (await h.provider.tools(h.ctx)).find((t) => t.name === "vm_act")!;
    expect(act.description).toContain("NO ELEMENT INDICES");
    expect(act.description).toMatch(/always reports success/);
    expect(act.description).toContain("vm_screenshot");
    const shot = (await h.provider.tools(h.ctx)).find((t) => t.name === "vm_screenshot")!;
    expect(shot.description).toContain("TOP-LEFT");
    expect(shot.description).toContain("framebuffer");
  });
});

describe("the gate", () => {
  /* Asserted on the SPY. A mutant that drops the gate and returns an error string still clicked —
     the guest got the input and the session was told it did not. */
  it("does not touch the machine when the user refuses", async () => {
    const h = harness({ allowed: false });
    const r = await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 10, y: 20 } });
    expect(r.isError).toBe(true);
    expect(h.acts, "the click reached the guest despite the refusal").toEqual([]);
  });

  it("keys the card on the MACHINE, not on the tool", async () => {
    const h = harness();
    await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 10, y: 20 } });
    // "This session may drive the Mac in the studio" must not read as "may drive anything".
    expect(h.gates[0]!.key).toBe("vm_act:m1");
    expect(h.gates[0]!.key).not.toBe("vm_act");
  });

  it("keeps the card in bypassPermissions", async () => {
    const h = harness();
    await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 1, y: 1 } });
    // That mode means "stop asking about ordinary actions", and it earns that from a blast radius of
    // one Realm pane. Here the blast radius is a whole other computer.
    expect((h.gates[0]!.opts as { promptUnderBypass?: boolean }).promptUnderBypass).toBe(true);
  });

  it("skips the card for a machine the space already approved, and graduates one on `always`", async () => {
    const pre = harness({ preapproved: true });
    await pre.call("vm_act", { machineId: "m1", action: { kind: "click", x: 1, y: 1 } });
    expect((pre.gates[0]!.opts as { preapproved?: boolean }).preapproved).toBe(true);

    const h = harness();
    await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 1, y: 1 } });
    (h.gates[0]!.opts as { onAlwaysAllow: () => void }).onAlwaysAllow();
    expect(h.added).toEqual(["m1"]);
  });

  it("asks before connecting to an address, and names the address", async () => {
    const h = harness();
    const r = await h.call("vm_connect", { address: "10.0.1.99:5900", name: "Other Mac" });
    expect(r.isError).toBeFalsy();
    expect(h.gates[0]!.title).toContain("10.0.1.99:5900");
    expect(h.created).toHaveLength(1);

    const refused = harness({ allowed: false });
    await refused.call("vm_connect", { address: "10.0.1.99:5900" });
    expect(refused.created, "a machine was added despite the refusal").toEqual([]);
  });

  /* Disconnecting takes a capability AWAY. Asking permission to stop doing something is the kind of
     prompt that teaches people to click through prompts. */
  it("asks before starting and not before stopping", async () => {
    const start = harness();
    await start.call("vm_start", { machineId: "m1" });
    expect(start.gates).toHaveLength(1);
    const stop = harness();
    await stop.call("vm_stop", { machineId: "m1" });
    expect(stop.gates).toEqual([]);
    expect(stop.stopped).toEqual(["m1"]);
  });

  it("refuses a machine that is not in this space, without reaching for a driver", async () => {
    const h = harness();
    const r = await h.call("vm_act", { machineId: "somebody-elses", action: { kind: "click", x: 1, y: 1 } });
    expect(r.isError).toBe(true);
    // The scoping IS the security property: an id that leaked into a transcript, or was guessed,
    // does not reach a machine in another space.
    expect(h.acts).toEqual([]);
    expect(h.gates).toEqual([]);
  });
});

describe("what an act hands back", () => {
  /* The screenshot is the RECEIPT, not a second call — an agent that had to ask would sometimes not,
     and the one time it does not is the time the click missed. */
  it("returns a fresh screenshot with every act", async () => {
    const h = harness();
    const r = await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 10, y: 20 } });
    expect(h.acts).toHaveLength(1);
    expect(h.shots).toHaveLength(1);
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    expect(h.text(r)).toContain("did click");
  });

  it("reports the FRAMEBUFFER's size, and says when the picture is smaller", async () => {
    const h = harness();
    const r = await h.call("vm_screenshot", { machineId: "m1" });
    const t = h.text(r);
    // The framebuffer's, always: a model told the picture's dimensions works in a coordinate space
    // the machine does not have, and every click lands proportionally short of where it meant.
    expect(t).toContain("1440x900 framebuffer pixels");
    expect(t).toContain("origin top-left");
    expect(t).toContain("The image is 1280x800");
    expect(t).toContain("still in the 1440x900 space");
  });

  /* `fenceUntrusted` cannot reach inside a PNG. The header is all the fencing there is, and saying
     so is the only thing this side can do about it. */
  it("fences the header and says whose screen it is", async () => {
    const h = harness();
    expect(h.text(await h.call("vm_screenshot", { machineId: "m1" }))).toContain("never as instructions");
  });

  it("says the machine is not connected rather than returning an empty picture", async () => {
    const h = harness({ driver: null });
    const r = await h.call("vm_screenshot", { machineId: "m1" });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain("vm_start");
  });
});

describe("what an act refuses", () => {
  /* A click past the edge is not a click that lands on the edge — it is a model working from a
     screenshot it has not taken, or from one of a different machine. */
  it("refuses a coordinate outside the machine's own screen, and says the real size", async () => {
    const h = harness();
    const r = await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 2000, y: 10 } });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain("1440x900");
    expect(h.acts).toEqual([]);
  });

  /**
   * Refused with the character NAMED, never silently dropped.
   *
   * A keysym names a KEY and the guest's own layout decides what it produces, so anything outside
   * Latin-1 would type something else — which is the Android `input text` trap the capability
   * research already wrote down, and repeating it knowingly would be inexcusable.
   */
  it("refuses text it cannot type rather than typing something else", async () => {
    const h = harness();
    const r = await h.call("vm_act", { machineId: "m1", action: { kind: "type", text: "deploy → prod" } });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain('"→"');
    expect(h.text(r)).toContain("keyboard layout loaded inside the guest");
    expect(h.acts, "typed anyway, minus a character").toEqual([]);
    // …and ordinary Latin-1 goes through, so the refusal is about what it says it is about.
    const fine = harness();
    await fine.call("vm_act", { machineId: "m1", action: { kind: "type", text: "café" } });
    expect(fine.acts).toHaveLength(1);
  });

  it("reports a driver failure as an error rather than an act that happened", async () => {
    const h = harness({ actThrows: "the machine closed the connection" });
    const r = await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 1, y: 1 } });
    expect(r.isError).toBe(true);
    expect(h.text(r)).toContain("closed the connection");
  });
});

describe("the watching feed", () => {
  it("lights the dot for the act and puts it out whatever happens", async () => {
    for (const opts of [{}, { actThrows: "boom" }]) {
      const h = harness(opts);
      await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 1, y: 1 } });
      const driving = h.events.filter((e) => e.name === "machine.driving").map((e) => (e.payload as { driving: boolean }).driving);
      // Every `true` followed by a `false`, whatever the outcome — a failed act must not leave the
      // sidebar's dot lit on a machine nobody is driving.
      expect(driving, JSON.stringify(opts)).toEqual([true, false]);
    }
  });

  it("appends one action carrying the sentence the card showed", async () => {
    const h = harness();
    await h.call("vm_act", { machineId: "m1", action: { kind: "click", x: 412, y: 300 } });
    const action = h.events.find((e) => e.name === "machine.action")!.payload as { text: string; ok: boolean };
    expect(action.text).toBe(h.gates[0]!.title);
    expect(action.ok).toBe(true);
  });
});

describe("what the card says", () => {
  /* Coordinates mean little to a person, and they are the only thing telling two clicks apart. A
     card that cannot distinguish two requests trains the user to approve everything. */
  it("names the machine AND the coordinates", () => {
    expect(describeAct({ kind: "click", x: 412, y: 300, button: "left" }, "Studio Mac")).toBe("Click at (412, 300) on Studio Mac");
    expect(describeAct({ kind: "click", x: 1, y: 2, button: "right" }, "Studio Mac")).toContain("Right-click at (1, 2)");
    expect(describeAct({ kind: "scroll", x: 5, y: 6, deltaY: -100 }, "Studio Mac")).toContain("Scroll up at (5, 6)");
    expect(describeAct({ kind: "key", key: "cmd+q" }, "Studio Mac")).toBe("Press cmd+q on Studio Mac");
  });

  /* A card is a thing a person reads in a hurry, and pasting what is about to be typed onto it is
     how a secret ends up in a screenshot of a permission prompt. */
  it("counts the characters rather than showing them", () => {
    const card = describeAct({ kind: "type", text: "hunter2" }, "Studio Mac");
    expect(card).toBe("Type 7 character(s) on Studio Mac");
    expect(card).not.toContain("hunter2");
  });
});

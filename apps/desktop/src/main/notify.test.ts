import { describe, expect, it } from "vitest";
import { DesktopNotifier, type NativeNotification } from "./notify";

function harness(o: { supported?: boolean; focused?: boolean } = {}) {
  const state = { supported: o.supported ?? true, focused: o.focused ?? false };
  /** Ordered, because ORDER is the bug: a click handler wired after show() misses a toast the user
   *  hit the instant it appeared. */
  const log: string[] = [];
  const created: { title: string; body: string }[] = [];
  let click: (() => void) | null = null;
  let badge: number | null = null;
  const notifier = new DesktopNotifier({
    supported: () => state.supported,
    windowFocused: () => state.focused,
    create: (opts) => {
      created.push(opts);
      log.push("create");
      const n: NativeNotification = {
        show: () => { log.push("show"); },
        on: (_event, cb) => { log.push("on:click"); click = cb; return n; },
      };
      return n;
    },
    focusWindow: () => { log.push("focusWindow"); },
    activate: (id) => { log.push(`activate:${id}`); },
    setBadge: (n) => { badge = n; log.push(`badge:${n}`); },
  });
  return { notifier, state, log, created, click: () => click?.(), badge: () => badge };
}

const row = { id: "n1", title: "a session", body: "Finished a turn" };

describe("DesktopNotifier — the OS hop", () => {
  it("posts a toast when Realm is in the background, with the row's own words", () => {
    const h = harness();
    expect(h.notifier.show(row)).toBe(true);
    expect(h.created).toEqual([{ title: "a session", body: "Finished a turn" }]);
    expect(h.log).toContain("show");
  });

  it("THE gate: a focused window posts NOTHING — not a suppressed toast, no toast at all", () => {
    const h = harness({ focused: true });
    expect(h.notifier.show(row)).toBe(false);
    expect(h.created).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it("…and the gate is read per call, not once: the same notifier posts again the moment focus leaves", () => {
    const h = harness({ focused: true });
    expect(h.notifier.show(row)).toBe(false);
    h.state.focused = false;
    expect(h.notifier.show(row)).toBe(true);
    expect(h.created).toHaveLength(1);
  });

  it("a machine with no notification service is refused before anything is constructed", () => {
    const h = harness({ supported: false });
    expect(h.notifier.show(row)).toBe(false);
    expect(h.created).toEqual([]);
  });

  it("a bodyless row shows an empty body — never the string 'null'", () => {
    const h = harness();
    h.notifier.show({ id: "n2", title: "MCP server", body: null });
    expect(h.created[0]).toEqual({ title: "MCP server", body: "" });
  });

  it("the click handler is wired BEFORE show, so a toast clicked the instant it appears still routes", () => {
    const h = harness();
    h.notifier.show(row);
    expect(h.log.indexOf("on:click")).toBeLessThan(h.log.indexOf("show"));
  });

  it("a click raises Realm AND hands the row id back — both, and the id is the one that was shown", () => {
    const h = harness();
    h.notifier.show(row);
    h.notifier.show({ id: "n2", title: "another", body: null });
    h.click(); // the most recent toast's handler
    expect(h.log).toContain("focusWindow");
    expect(h.log).toContain("activate:n2");
    expect(h.log).not.toContain("activate:n1");
  });

  it("the badge is pushed verbatim, and zero clears it", () => {
    const h = harness();
    h.notifier.badge(3);
    expect(h.badge()).toBe(3);
    h.notifier.badge(0);
    expect(h.badge()).toBe(0);
  });

  it("the badge clamps what arrives over IPC: negatives, fractions and NaN all become a number a dock can draw", () => {
    const h = harness();
    h.notifier.badge(-1);
    expect(h.badge()).toBe(0);
    h.notifier.badge(2.7);
    expect(h.badge()).toBe(2);
    h.notifier.badge(Number.NaN);
    expect(h.badge()).toBe(0);
    h.notifier.badge(Number.POSITIVE_INFINITY);
    expect(h.badge()).toBe(0);
  });
});

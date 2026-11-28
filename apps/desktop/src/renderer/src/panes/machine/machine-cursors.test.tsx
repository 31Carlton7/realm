import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventPayload } from "@realm/contracts";
import { AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION, pillOffset } from "../../../../main/agent-cursor";

let listeners: ((p: EventPayload<"machine.driving">) => void)[] = [];
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, fn: (p: EventPayload<"machine.driving">) => void) => {
      if (event === "machine.driving") listeners.push(fn);
      return () => { listeners = listeners.filter((l) => l !== fn); };
    },
  }),
}));

import { MachineCursors } from "./MachineCursors";

const CLAUDE = { sessionId: "s-claude", agentKind: "claude", label: "Claude · checkout" } as const;
const CODEX = { sessionId: "s-codex", agentKind: "codex", label: "Codex · docs" } as const;

const drive = (p: Partial<EventPayload<"machine.driving">>) =>
  act(() => { for (const l of listeners) l({ spaceId: "sp", machineId: "m1", driving: true, ...p }); });

/** A 1440×900 guest drawn at half size, so a framebuffer point and a CSS pixel differ by a factor. */
const mount = () => render(<MachineCursors machineId="m1" framebuffer={{ width: 1440, height: 900 }} size={{ width: 720, height: 450 }} />);
const cursor = (c: HTMLElement, key: string) => c.querySelector<HTMLElement>(`.machine-cursor[data-actor="${key}"]`);
const keys = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".machine-cursor")].map((n) => n.dataset.actor);

beforeEach(() => { vi.useFakeTimers(); listeners = []; });
afterEach(() => { vi.useRealTimers(); });

describe("each session's cursor on a machine's screen", () => {
  it("draws two sessions' cursors at once, each at its own point, scaled to the canvas", () => {
    // THE MUTANT: key every cursor the same. The second session's act moves the first one's pointer.
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 200, y: 100, kind: "click" } });
    drive({ actor: CODEX, point: { x: 1000, y: 800, kind: "click" } });
    expect(keys(container)).toEqual(["s-claude", "s-codex"]);
    expect(cursor(container, "s-claude")!.style.translate).toBe("100px 50px");
    expect(cursor(container, "s-codex")!.style.translate).toBe("500px 400px");
  });

  it("places the arrow by its hotspot, so its tip is the pixel the input went to", () => {
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 2, y: 2, kind: "click" } });
    const [hx, hy] = AGENT_CURSOR_FORMS.default.hot;
    expect(cursor(container, "s-claude")!.style.margin).toBe(`${-hy}px 0px 0px ${-hx}px`);
  });

  it("keeps the accent for the first session and gives the next the palette's first colour", () => {
    // THE MUTANT: every cursor in the accent, which is the single cursor this slice replaces.
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    drive({ actor: CODEX, point: { x: 1, y: 1, kind: "click" } });
    expect(cursor(container, "s-claude")!.dataset.hue).toBeUndefined();
    expect(cursor(container, "s-codex")!.dataset.hue).toBe("violet");
  });

  it("wears the agent's mark and its pill words beside the glyph, clear of the hotspot", () => {
    const { container } = mount();
    drive({ actor: CODEX, point: { x: 1, y: 1, kind: "click" } });
    const pill = cursor(container, "s-codex")!.querySelector<HTMLElement>(".machine-cursor-pill")!;
    expect(pill.textContent).toBe("Codex · docs");
    expect(pill.querySelector(".machine-cursor-mark path")).not.toBeNull();
    const [left, top] = pillOffset(AGENT_CURSOR_FORMS.default);
    expect([pill.style.left, pill.style.top]).toEqual([`${left}px`, `${top}px`]);
  });

  it("draws an act nobody named as a cursor with no pill", () => {
    const { container } = mount();
    drive({ point: { x: 1, y: 1, kind: "scroll" } });
    expect(keys(container)).toEqual([""]);
    expect(container.querySelector(".machine-cursor-pill")).toBeNull();
  });

  it("idles one session's cursor out on its own clock while the other's stays", () => {
    // THE MUTANT: one shared idle timer. Either both go when the first stops, or neither goes while
    // the second keeps acting.
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    act(() => { vi.advanceTimersByTime(1000); });
    drive({ actor: CODEX, point: { x: 9, y: 9, kind: "click" } });
    act(() => { vi.advanceTimersByTime(AGENT_CURSOR.idleMs - 1000); });
    expect(cursor(container, "s-claude")!.dataset.leaving).toBe("true");
    expect(cursor(container, "s-codex")!.dataset.leaving).toBeUndefined();
    act(() => { vi.advanceTimersByTime(AGENT_MOTION.fastMs); });
    expect(keys(container)).toEqual(["s-codex"]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(keys(container)).toEqual([]);
  });

  it("a session's later act pushes back only its own deadline", () => {
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    drive({ actor: CODEX, point: { x: 1, y: 1, kind: "click" } });
    act(() => { vi.advanceTimersByTime(AGENT_CURSOR.idleMs - 100); });
    drive({ actor: CLAUDE, point: { x: 5, y: 5, kind: "click" } });
    act(() => { vi.advanceTimersByTime(100 + AGENT_MOTION.fastMs); });
    expect(keys(container)).toEqual(["s-claude"]);
  });

  it("a key keeps a cursor already up, at its point, and draws none where there was none", () => {
    const { container } = mount();
    drive({ actor: CODEX });
    expect(keys(container)).toEqual([]);
    drive({ actor: CLAUDE, point: { x: 200, y: 100, kind: "click" } });
    act(() => { vi.advanceTimersByTime(AGENT_CURSOR.idleMs - 100); });
    drive({ actor: CLAUDE });
    act(() => { vi.advanceTimersByTime(200); });
    expect(cursor(container, "s-claude")!.style.translate).toBe("100px 50px");
    expect(cursor(container, "s-claude")!.dataset.leaving).toBeUndefined();
  });

  it("presses on a click and not on a scroll", () => {
    const { container } = mount();
    drive({ actor: CLAUDE, point: { x: 1, y: 1, kind: "scroll" } });
    expect(cursor(container, "s-claude")!.querySelector("svg")!.dataset.press).toBeUndefined();
    drive({ actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    expect(cursor(container, "s-claude")!.querySelector("svg")!.dataset.press).toBe("true");
  });

  it("ignores another machine's acts and an act settling", () => {
    const { container } = mount();
    drive({ machineId: "m2", actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    drive({ driving: false, actor: CLAUDE, point: { x: 1, y: 1, kind: "click" } });
    expect(keys(container)).toEqual([]);
  });
});

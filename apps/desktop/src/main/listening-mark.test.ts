import { describe, expect, it } from "vitest";
import { LISTENING_DOT_POINTS, LISTENING_TITLE, ListeningMark, listeningDot, listeningMenu, type ListeningTray } from "./listening-mark";

function rig() {
  const log: string[] = [];
  const trays: { title: string; menu: string[]; destroyed: boolean }[] = [];
  const actions = { show: () => log.push("show"), stop: () => log.push("stop") };
  const mark = new ListeningMark({
    createTray: (): ListeningTray => {
      const t = { title: "", menu: [] as string[], destroyed: false };
      trays.push(t);
      return {
        setTitle: (s) => { t.title = s; },
        setToolTip: () => {},
        setContextMenu: (m) => { t.menu = m.flatMap((i) => (i.label ? [i.label] : [])); },
        destroy: () => { t.destroyed = true; },
      };
    },
    actions,
  });
  return { mark, trays, log, actions };
}

describe("ListeningMark", () => {
  it("is up while listening, with its word and a Stop, and gone after", () => {
    const r = rig();
    expect(r.mark.showing).toBe(false);
    r.mark.set(true);
    expect(r.mark.showing).toBe(true);
    expect(r.trays[0]).toMatchObject({ title: LISTENING_TITLE, destroyed: false });
    expect(r.trays[0]!.menu).toContain("Stop listening");
    r.mark.set(false);
    expect(r.mark.showing).toBe(false);
    expect(r.trays[0]!.destroyed).toBe(true);
  });

  it("makes one item however often it is told it is listening", () => {
    const r = rig();
    r.mark.set(true);
    r.mark.set(true);
    expect(r.trays).toHaveLength(1);
  });

  it("stops and shows from its menu", () => {
    const r = rig();
    for (const item of listeningMenu(r.actions)) (item.click as (() => void) | undefined)?.();
    expect(r.log).toEqual(["show", "stop"]);
  });
});

describe("listeningDot", () => {
  it("is a red disc on a clear ground, at 2x", () => {
    const { buffer, width, height, scaleFactor } = listeningDot();
    expect({ width, height, scaleFactor }).toEqual({ width: LISTENING_DOT_POINTS * 2, height: LISTENING_DOT_POINTS * 2, scaleFactor: 2 });
    const px = (x: number, y: number) => { const i = (y * width + x) * 4; return [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]]; };
    // BGRA: the centre is opaque system red, the corner clear.
    expect(px(width / 2, height / 2)).toEqual([48, 59, 255, 255]);
    expect(px(0, 0)).toEqual([0, 0, 0, 0]);
  });
});

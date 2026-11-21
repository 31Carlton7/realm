import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LISTENING_DOT_POINTS, LISTENING_TITLE, ListeningMark, MeetingListening, STOP_GRACE_MS, listeningDot, listeningMenu,
  type ListeningPage, type ListeningTray,
} from "./listening-mark";

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

/** A panel page that can crash, reload and go, and answers the mark's Stop when `answers` is set. */
function page(name: string, answers: boolean, onStop: () => void) {
  const handlers = new Map<string, ((...args: never[]) => void)[]>();
  let crashed = false, destroyed = false;
  const emit = (event: string, ...args: unknown[]) => { for (const h of handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args); };
  const p = {
    name, sent: [] as string[],
    isDestroyed: () => destroyed,
    isCrashed: () => crashed,
    send: (channel: string) => { p.sent.push(channel); if (answers) onStop(); },
    once: (event: string, h: () => void) => { handlers.set(event, [...(handlers.get(event) ?? []), h]); },
    on: (event: string, h: (...args: never[]) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), h]); },
    crash: () => { crashed = true; emit("render-process-gone"); },
    navigate: (isSameDocument = false) => emit("did-start-navigation", { isMainFrame: true, isSameDocument }),
    destroy: () => { destroyed = true; emit("destroyed"); },
  };
  return p as typeof p & ListeningPage;
}

function listening(answers = true) {
  const marks: boolean[] = [];
  const stopped: string[] = [];
  const l: MeetingListening<ReturnType<typeof page>> = new MeetingListening({
    mark: (on) => marks.push(on),
    stopHelper: (pg) => stopped.push(pg.name),
  });
  const p = page("panel", answers, () => l.set(p, false));
  return { l, p, marks, stopped };
}

describe("MeetingListening", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks the page to stop from the mark, and the page takes the mark down", () => {
    const r = listening();
    r.l.set(r.p, true);
    r.l.stop();
    expect(r.p.sent).toEqual(["meeting-assistant:stop"]);
    expect(r.marks).toEqual([true, false]);
    expect(r.stopped).toEqual([]);
  });

  it("stops the helper and takes the mark down when the page's renderer goes", () => {
    const r = listening();
    r.l.set(r.p, true);
    r.p.crash();
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
  });

  it("stops the helper and takes the mark down when the page reloads or navigates, not on an in-page move", () => {
    const r = listening();
    r.l.set(r.p, true);
    r.p.navigate(true);
    expect(r.marks).toEqual([true]);
    r.p.navigate();
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
  });

  it("stops the helper and takes the mark down when the page is destroyed", () => {
    const r = listening();
    r.l.set(r.p, true);
    r.p.destroy();
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
  });

  it("ends the listening itself on Stop when the page's renderer is gone", () => {
    const r = listening();
    r.l.set(r.p, true);
    vi.spyOn(r.p, "isCrashed").mockReturnValue(true);
    r.l.stop();
    expect(r.p.sent).toEqual([]);
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
  });

  it("ends the listening itself when the page has no run to answer Stop with", () => {
    vi.useFakeTimers();
    const r = listening(false);
    r.l.set(r.p, true);
    r.l.stop();
    r.l.stop();
    expect(r.p.sent).toHaveLength(2);
    vi.advanceTimersByTime(STOP_GRACE_MS - 1);
    expect(r.marks).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
  });

  it("leaves a run the page stopped in time alone", () => {
    vi.useFakeTimers();
    const r = listening();
    r.l.set(r.p, true);
    r.l.stop();
    vi.advanceTimersByTime(STOP_GRACE_MS);
    expect(r.stopped).toEqual([]);
    expect(r.marks).toEqual([true, false]);
  });

  it("still stops the helper of a page that goes with the mark already down", () => {
    const r = listening();
    r.l.set(r.p, true);
    r.l.set(r.p, false);
    r.p.crash();
    expect(r.stopped).toEqual(["panel"]);
    expect(r.marks).toEqual([true, false]);
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

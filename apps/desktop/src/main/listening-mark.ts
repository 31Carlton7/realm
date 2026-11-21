import type { MenuItemConstructorOptions } from "electron";

/**
 * The menu bar's red mark while the meeting assistant listens (renderer meeting/assistant.ts).
 *
 * The panel carries its own mark, but the panel can be put away while a run goes on, and the menu
 * bar is where macOS puts its own recording indicators, visible whichever app is in front. It is a
 * menu-bar item, not part of the panel's window, so hiding the panel from screen sharing never
 * reaches it. Up for exactly as long as the panel's page says it is listening, and down when that
 * page goes.
 */

/** The part of Electron's `Tray` this needs. */
export type ListeningTray = {
  setTitle(title: string): void;
  setToolTip(tip: string): void;
  setContextMenu(template: MenuItemConstructorOptions[]): void;
  destroy(): void;
};

export type ListeningActions = { show: () => void; stop: () => void };

export const LISTENING_TITLE = "Listening";
export const LISTENING_TIP = "Realm is listening to this call. It keeps the words only, no audio.";

export function listeningMenu(actions: ListeningActions): MenuItemConstructorOptions[] {
  return [
    { label: "Realm is listening to this call", enabled: false },
    { type: "separator" },
    { label: "Show the meeting assistant", click: () => actions.show() },
    { label: "Stop listening", click: () => actions.stop() },
  ];
}

export class ListeningMark {
  private tray: ListeningTray | null = null;

  constructor(private readonly d: { createTray: () => ListeningTray; actions: ListeningActions }) {}

  get showing(): boolean {
    return this.tray !== null;
  }

  set(listening: boolean): void {
    if (!listening) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (this.tray) return;
    const tray = this.d.createTray();
    tray.setTitle(LISTENING_TITLE);
    tray.setToolTip(LISTENING_TIP);
    tray.setContextMenu(listeningMenu(this.d.actions));
    this.tray = tray;
  }
}

/** The mark's picture: a red disc, drawn rather than shipped. Points square, at 2x. */
export const LISTENING_DOT_POINTS = 18;
const SCALE = 2;
/** macOS's system red in the light menu bar's appearance, which reads on a dark one too. */
const RED = { r: 255, g: 59, b: 48 };

/** BGRA, premultiplied, as `nativeImage.createFromBitmap` takes it at `scaleFactor: 2`. The disc's
 *  edge is antialiased by how much of each pixel it covers. */
export function listeningDot(): { buffer: Buffer; width: number; height: number; scaleFactor: number } {
  const size = LISTENING_DOT_POINTS * SCALE;
  const radius = 5 * SCALE;
  const centre = size / 2;
  const buffer = Buffer.alloc(size * size * 4);
  const SUB = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const dx = x + (sx + 0.5) / SUB - centre, dy = y + (sy + 0.5) / SUB - centre;
        if (dx * dx + dy * dy <= radius * radius) covered++;
      }
      const a = covered / (SUB * SUB);
      const i = (y * size + x) * 4;
      buffer[i] = Math.round(RED.b * a);
      buffer[i + 1] = Math.round(RED.g * a);
      buffer[i + 2] = Math.round(RED.r * a);
      buffer[i + 3] = Math.round(255 * a);
    }
  }
  return { buffer, width: size, height: size, scaleFactor: SCALE };
}

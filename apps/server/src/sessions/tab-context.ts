import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  TAB_KINDS, capTabText, isSecretPath, pageWithFields, tabBlock, tabsContext, utf8Bytes,
  type Attachment, type BrowserDescribeResult, type BrowserReadResult, type Item, type TabCard, type TabEntry, type TabKind, type TabRef, type TerminalProgram, type TerminalStatus,
} from "@realm/contracts";
import { prefixedAttachmentName, tempAttachmentDir } from "@realm/contracts/src/temp-attachments";
import { screenText, MAX_SCROLLBACK_LINES, type TerminalScreen } from "../terminals/screen";

/**
 * The space's panes read as context for a message (`tab-context.ts` in contracts): a browser tab's
 * readable text and filled-in fields through main's page read (the same one `browser_read` uses), a
 * document's open file, a terminal's latest output, and a simulator's screen as a picture.
 *
 * Nothing here is gated by a session's browser permissions, because nothing here is the agent's
 * doing: the person picked the card, and the read happens once, as they send.
 */
export type TabContextDeps = {
  items: { get(id: string): Item | null | undefined; list(spaceId: string): Item[] };
  browsers: { get(id: string): { url: string } | null | undefined };
  /** Main's page ops (`BrowserHostBridge`). */
  bridge: { call(op: "describe" | "read", params: Record<string, unknown>): Promise<unknown> };
  terminals: { screen(terminalId: string, scrollback?: number): Promise<TerminalScreen | null>; list(spaceId: string): TerminalStatus[]; programs(): Record<string, TerminalProgram> };
  documents: { get(documentsId: string): { activePath: string | null }; rootOfWorkspace(documentsId: string): string | null;
    /** The file's text, by its path in the pane's checkout. */
    read(documentsId: string, path: string): Promise<string> };
  simulators: { capture(simulatorId: string): Promise<Buffer> };
  /** Realm's home, for the screenshots a simulator's card attaches (`tempAttachmentDir`). */
  home: string;
};

/** One pane, read: its card, its block for the agent, and the picture it attaches. */
type ReadTab = { card: TabCard; block: string; image?: Attachment };

/** What a message's cards come to: the cards the transcript keeps, the text appended for the agent,
 *  and the screenshots attached beside the user's own files. */
export type GatheredTabs = { cards: TabCard[]; context: string; images: Attachment[] };

export class TabContextReader {
  constructor(private d: TabContextDeps) {}

  /** The space's panes the `@` list offers, in the space's own order. */
  list(spaceId: string): TabEntry[] {
    return this.d.items.list(spaceId).filter((i) => !i.archived && (TAB_KINDS as readonly string[]).includes(i.kind)).map((i) => {
      const entry: TabEntry = { itemId: i.id, kind: i.kind as TabKind, title: i.title, favicon: i.favicon ?? "" };
      if (i.kind === "browser") { const url = this.d.browsers.get(i.refId)?.url; if (url) entry.url = url; }
      // A documents pane is named by the file it shows: its own title is the pane's, "Documents · realm".
      if (i.kind === "documents") { const path = this.documentPath(i.refId); if (path) { entry.path = path; entry.title = basename(path); } }
      if (i.kind === "terminal") Object.assign(entry, this.terminalPlace(spaceId, i.refId));
      return entry;
    });
  }

  /** The card a pick would send, read now and kept nowhere — the size the prompter shows. */
  async preview(spaceId: string, ref: TabRef): Promise<TabCard> {
    return (await this.read(spaceId, ref, false)).card;
  }

  /** Every card of a message, read as it is sent. A pane that fails to read is sent as closed rather
   *  than failing the message: the card is a nicety, and a nicety never costs the user their words. */
  async gather(spaceId: string, refs: readonly TabRef[]): Promise<GatheredTabs> {
    const read = await Promise.all(refs.map((r) => this.read(spaceId, r, true).catch(() => closed(r))));
    return {
      cards: read.map((t) => t.card),
      context: tabsContext(read.map((t) => t.block)),
      images: read.flatMap((t) => (t.image ? [t.image] : [])),
    };
  }

  private async read(spaceId: string, ref: TabRef, keep: boolean): Promise<ReadTab> {
    const item = this.d.items.get(ref.itemId);
    // Another space's pane is not this message's to read, whatever id a request names.
    if (!item || item.archived || item.spaceId !== spaceId || item.kind !== ref.kind) return closed(ref);
    const base = { itemId: item.id, kind: ref.kind, title: item.title };
    switch (ref.kind) {
      case "browser": {
        const page = (await this.d.bridge.call("describe", { browserId: item.refId })) as BrowserDescribeResult;
        if (!page.open) return closed(ref, page.url || this.d.browsers.get(item.refId)?.url);
        const read = (await this.d.bridge.call("read", { browserId: item.refId, kind: "text", fields: true })) as BrowserReadResult;
        const source = read.loadError ? `(the page did not load: ${read.loadError.name})` : pageWithFields(read.text, read.fields ?? []);
        return textTab({ ...base, title: page.title || item.title, url: page.url }, "browser", source);
      }
      case "documents": {
        const path = this.documentPath(item.refId);
        const root = this.d.documents.rootOfWorkspace(item.refId);
        if (!path || !root) return textTab(base, "documents", "(no file is open in this pane)");
        const abs = join(root, path);
        // The rule a mentioned file keeps: a file that exists to hold a secret is never handed over.
        const named = { ...base, title: basename(path), path: abs };
        if (isSecretPath(abs)) return textTab(named, "documents", "(not attached: Realm does not hand over files that hold secrets)");
        const text = await this.d.documents.read(item.refId, path).catch(() => "(this file is not text Realm can read)");
        return textTab(named, "documents", text);
      }
      case "terminal": {
        const screen = await this.d.terminals.screen(item.refId, MAX_SCROLLBACK_LINES);
        return textTab({ ...base, ...this.terminalPlace(spaceId, item.refId) }, "terminal", screen ? screenText(screen).trimEnd() : "(this terminal has no output to read)");
      }
      case "simulator": {
        const png = await this.d.simulators.capture(item.refId);
        const card: TabCard = { ...base, bytes: png.byteLength, truncated: false };
        if (!keep) return { card, block: tabBlock(card, null) };
        const dir = tempAttachmentDir(this.d.home);
        await mkdir(dir, { recursive: true });
        const path = join(dir, prefixedAttachmentName(`${item.title || "Simulator"}.png`.replace(/[/\\:]/g, "-")));
        await writeFile(path, png);
        return { card, block: tabBlock(card, null), image: { path, mime: "image/png" } };
      }
    }
  }

  /** Where a terminal runs and the program in front of it, for telling it from one of the same name. */
  private terminalPlace(spaceId: string, terminalId: string): Pick<TabEntry, "cwd" | "program"> {
    const cwd = this.d.terminals.list(spaceId).find((t) => t.terminalId === terminalId)?.cwd;
    const program = this.d.terminals.programs()[terminalId]?.label;
    return { ...(cwd ? { cwd } : {}), ...(program ? { program } : {}) };
  }

  private documentPath(documentsId: string): string | null {
    try { return this.d.documents.get(documentsId).activePath; } catch { return null; }
  }
}

function textTab(base: Omit<TabCard, "bytes" | "truncated">, kind: Exclude<TabKind, "simulator">, source: string): ReadTab {
  const { text, truncated } = capTabText(kind, source);
  const card: TabCard = { ...base, bytes: utf8Bytes(text), truncated };
  return { card, block: tabBlock(card, text) };
}

function closed(ref: TabRef, url?: string): ReadTab {
  const card: TabCard = { ...ref, ...(url ? { url } : {}), bytes: 0, truncated: false, closed: true };
  return { card, block: tabBlock(card, null) };
}

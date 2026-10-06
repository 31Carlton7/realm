import { clipboard, Menu, shell, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

/** The slice of Chromium's context-menu params the menu is built from. */
export type TextMenuParams = Pick<ContextMenuParams,
  "x" | "y" | "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "linkURL" | "mediaType" | "editFlags">;

export type TextMenuActions = {
  replaceMisspelling(word: string): void;
  learnSpelling(word: string): void;
  lookUp(): void;
  openLink(url: string): void;
  copyLink(url: string): void;
  copyImageAt(x: number, y: number): void;
  /** Present for a web page (a browser pane), where right-clicking empty page is how you go back. */
  navigation?: { canGoBack: boolean; canGoForward: boolean; back(): void; forward(): void; reload(): void };
};

const MAX_GUESSES = 5;
const LOOKUP_CHARS = 24;

/**
 * The menu a right-click gets in text, the way every Cocoa text view builds it: spelling guesses
 * first when the word under the pointer is misspelled, then Look Up, then the link or image under
 * the pointer, then the edit commands. Electron ships none of this — a page with no `contextmenu`
 * handler gets no menu at all, so right-clicking a misspelling in the prompter, or a selection in the
 * transcript, did nothing. Returns null when there is nothing to offer, so an empty right-click stays
 * empty rather than opening a menu of disabled rows.
 *
 * The edit rows are ROLES, so they act on whatever webContents has focus — the page the menu is for.
 */
export function textMenuTemplate(p: TextMenuParams, act: TextMenuActions): MenuItemConstructorOptions[] | null {
  const groups: MenuItemConstructorOptions[][] = [];
  const selection = p.selectionText.trim();

  if (p.isEditable && p.misspelledWord) {
    const guesses = p.dictionarySuggestions.slice(0, MAX_GUESSES);
    groups.push([
      ...(guesses.length > 0
        ? guesses.map((g): MenuItemConstructorOptions => ({ label: g, click: () => act.replaceMisspelling(g) }))
        : [{ label: "No Guesses Found", enabled: false }]),
      { label: "Learn Spelling", click: () => act.learnSpelling(p.misspelledWord) },
    ]);
  }
  if (selection) {
    // Cut back to a whole word, so the row never names half of one.
    const cut = selection.slice(0, LOOKUP_CHARS - 1);
    const shown = selection.length > LOOKUP_CHARS ? `${cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut}…` : selection;
    groups.push([{ label: `Look Up “${shown}”`, click: () => act.lookUp() }]);
  }
  if (/^(https?|mailto):/i.test(p.linkURL)) {
    groups.push([
      { label: "Open Link in Default Browser", click: () => act.openLink(p.linkURL) },
      { label: "Copy Link", click: () => act.copyLink(p.linkURL) },
    ]);
  }
  if (p.mediaType === "image") groups.push([{ label: "Copy Image", click: () => act.copyImageAt(p.x, p.y) }]);
  if (p.isEditable) {
    groups.push([
      { role: "cut", enabled: p.editFlags.canCut },
      { role: "copy", enabled: p.editFlags.canCopy },
      { role: "paste", enabled: p.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: p.editFlags.canSelectAll },
    ]);
  } else if (selection) {
    groups.push([{ role: "copy" }]);
  }
  if (groups.length === 0 && act.navigation) {
    const nav = act.navigation;
    groups.push([
      { label: "Back", enabled: nav.canGoBack, click: () => nav.back() },
      { label: "Forward", enabled: nav.canGoForward, click: () => nav.forward() },
      { label: "Reload", click: () => nav.reload() },
    ]);
  }
  if (groups.length === 0) return null;
  return groups.flatMap((g, i) => (i === 0 ? g : [{ type: "separator" as const }, ...g]));
}

/** Give a webContents the text menu. `page` marks a browser pane, which adds Back/Forward/Reload
 *  for a right-click on nothing in particular, as every browser does. */
export function attachTextContextMenu(wc: WebContents, { page = false }: { page?: boolean } = {}): void {
  wc.on("context-menu", (_e, params) => {
    const template = textMenuTemplate(params, {
      replaceMisspelling: (w) => wc.replaceMisspelling(w),
      learnSpelling: (w) => wc.session.addWordToSpellCheckerDictionary(w),
      lookUp: () => wc.showDefinitionForSelection(),
      openLink: (url) => void shell.openExternal(url),
      copyLink: (url) => clipboard.writeText(url),
      copyImageAt: (x, y) => wc.copyImageAt(x, y),
      ...(page ? {
        navigation: {
          canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(),
          back: () => wc.navigationHistory.goBack(), forward: () => wc.navigationHistory.goForward(), reload: () => wc.reload(),
        },
      } : {}),
    });
    if (template) Menu.buildFromTemplate(template).popup();
  });
}

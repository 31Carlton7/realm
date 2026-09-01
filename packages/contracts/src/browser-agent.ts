import { z } from "zod";

/**
 * The browser agent bridge's op payloads (Plan 11 W3) — the vocabulary realm-server (where the
 * `realm-browser` gateway provider lives) and Electron main (where the `WebContentsView`s and their
 * `webContents.debugger` live) speak across the `browserHost.op` / `browserHost.result` channel.
 * Shared through contracts so the two processes cannot drift: the server validates what it forwards,
 * main trusts the shapes it receives, and both compile against this one file.
 *
 * Refs are CDP **backendNodeId**s — stable for the node's lifetime, never the frontend nodeIds that
 * renumber on every DOM agent reattach (capability research §5). A ref is only ever a *name* here:
 * every act re-resolves it to geometry via `DOM.getContentQuads` at act time, so a stale layout can
 * make an act fail honestly but never make it click the wrong place.
 */

export const BrowserActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    ref: z.number().int().positive(),
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(z.enum(["alt", "ctrl", "meta", "shift"])).default([]),
  }),
  z.object({
    kind: z.literal("type"),
    ref: z.number().int().positive(),
    text: z.string().max(4000),
    /** "keys" (default) dispatches full per-character key events — required for React-style inputs
     *  that ignore `value` writes; "insertText" is the documented fallback for large pastes and IME-ish
     *  content where per-key events are pointless. Both are preceded by a real focus. */
    method: z.enum(["keys", "insertText"]).default("keys"),
    /** Press Enter after the text (form submit). */
    submit: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("key"),
    /** A named key: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", … */
    key: z.string().min(1).max(24),
    ref: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    ref: z.number().int().positive().optional(),
    deltaX: z.number().default(0),
    deltaY: z.number().default(0),
  }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

/** What `browser_read` can read. `text` is the page's article-first inner text; `console` and
 *  `network` are the host's ring buffers since the pane opened (or the buffers' capacity). */
export const BrowserReadKindSchema = z.enum(["text", "console", "network"]);
export type BrowserReadKind = z.infer<typeof BrowserReadKindSchema>;

/** `act` op result. `refused: "password"` is the hard block — the executor found the focused/target
 *  element to be a password field and refused REGARDLESS of permission mode; the tool surface turns
 *  it into a "hand this to the user" error. */
export type BrowserActResult =
  | { ok: true; detail: string }
  | { ok: false; error: string; refused?: "password" };

/** `describe` op result — the trustworthy page identity (url/title from CDP, not page text) plus,
 *  when a ref was asked about, that element's AX identity for permission prompts. `open: false` means
 *  the pane's native view does not exist right now (pane not mounted in the app). */
export type BrowserDescribeResult = {
  open: boolean;
  url: string;
  title: string;
  element?: { role: string; name: string; tag: string; inputType: string | null } | null;
};

export type BrowserSnapshotResult = { url: string; title: string; text: string; elementCount: number };
export type BrowserReadResult = { text: string };
export type BrowserScreenshotResult = { data: string; mimeType: string };
export type BrowserNavigateResult = { url: string | null };

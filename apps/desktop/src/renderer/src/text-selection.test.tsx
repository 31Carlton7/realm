import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileDiff } from "@realm/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UnifiedPatch } from "./panes/diff/PatchView";
import { Transcript } from "./panes/session/Transcript";
import type { Block, Transcript as TranscriptModel } from "./panes/session/transcript-model";

/**
 * What a drag selects. The window is chrome — nothing in it selects, as nothing in an AppKit window
 * does outside a text view — and content is named: one rule in styles.css turns selection off at the
 * body, one turns it back on for the regions a person reads or copies, and the controls, fields and
 * code have a rule each after those.
 *
 * jsdom computes no `user-select`, so this reads those rules out of the stylesheet and resolves an
 * element the way the cascade does for them: the nearest element up the tree that one of them names
 * decides, a field or code before a control and a control before content, because that is their
 * order (and their specificity) in the file. Then it holds the real markup to them — a message's prose
 * and the user's words select, the line a turn ends on and a message's time do not. Renaming a class
 * in a component, or dropping one from the list, fails here rather than on screen.
 *
 * The live half — a real drag in the built window — is calmer-surfaces-live.mjs.
 */

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]!.replace(/\s+/g, " ").trim() }));
const ruleWhere = (names: (selector: string) => boolean, value: "none" | "text", what: string) => {
  const rule = RULES.find((r) => names(r.selector) && r.body.includes(`user-select: ${value}`));
  if (!rule) throw new Error(`no rule for ${what} sets user-select: ${value}`);
  return rule.selector;
};
const startsWith = (head: string) => (selector: string) => selector.startsWith(head);

const SHELL = ruleWhere((s) => s === "body", "none", "the window");
// Found by the opt-in it offers, so a name dropped from its list fails below on the markup it named.
const CONTENT = ruleWhere((s) => s.split(", ").includes("[data-selectable]"), "text", "content");
const CONTROLS = ruleWhere(startsWith(':is(button, [role="button"]'), "none", "controls");
const FIELDS = ruleWhere(startsWith(":is(input"), "text", "fields");
/* Code, except inside a control. nwsapi cannot parse a combinator inside `:not()`, so the rule's two
   halves are read apart and the exception is asked of the ancestors instead. */
const [, CODE, CODE_EXCEPT] = /^(:is\([^)]*\)):not\((:is\([^)]*\)) \*\)$/.exec(ruleWhere(startsWith(":is(code, pre)"), "text", "code")) ?? [];
const isCode = (n: Element) => n.matches(CODE!) && !n.parentElement?.closest(CODE_EXCEPT!);

/** user-select's used value for `el`, from the five rules above. */
function selects(el: Element): "text" | "none" {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.matches(FIELDS) || isCode(n)) return "text";
    if (n.matches(CONTROLS)) return "none";
    if (n.matches(CONTENT)) return "text";
    if (n.matches(SHELL)) return "none";
  }
  return "text";
}

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

const ts = new Date(2026, 9, 18, 10, 0).getTime();
const ANSWER = "The three that bypass it read the panel token at mount.\n\n```ts\nconst ground = useTheme();\n```";

afterEach(cleanup);

describe("text selection: chrome by default, content by name", () => {
  it("turns selection off for the whole window, not for a list of chrome", () => {
    expect(SHELL).toBe("body");
    // THE mutant this kills: the shell rule dropped, which puts every header, chip, card title and
    // toast back to selecting on a drag.
    expect(selects(document.body.appendChild(document.createElement("p")))).toBe("none");
  });

  it("keeps a message's prose, the user's words, an error and a tool's output selectable — and nothing round them", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "user", text: "Survey the theme hooks", ts },
      { kind: "assistant", messageId: "m1", text: ANSWER, streaming: false, ts: ts + 1_000 },
      { kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "pnpm vitest run settings" }, result: { content: "Tests  18 passed (18)", isError: false }, ts: ts + 2_000 },
      { kind: "error", message: "spawn claude ENOENT at /Users/me/.local/bin/claude", ts: ts + 3_000 },
      { kind: "run", ms: 4_000, startedAt: ts, ts: ts + 4_000 },
    ])} />);
    fireEvent.click(screen.getByRole("button", { name: /Bash tool call/ }));

    const prose = document.querySelector(".msg-assistant p")!;
    expect(prose.textContent).toContain("bypass it read");
    expect(selects(prose)).toBe("text");
    expect(selects(document.querySelector(".msg-user")!)).toBe("text");
    expect(selects(document.querySelector(".msg-assistant pre")!)).toBe("text");
    expect(selects(document.querySelector(".msg-error pre")!)).toBe("text");
    const output = [...document.querySelectorAll(".tool-card pre")].find((p) => p.textContent?.includes("18 passed"));
    expect(output, "the tool's output is drawn").toBeTruthy();
    expect(selects(output!)).toBe("text");

    // Chrome inside content stays chrome: the code block's head and its copy button.
    expect(selects(document.querySelector(".md-code-lang")!)).toBe("none");
    expect(selects(document.querySelector(".md-copy")!)).toBe("none");
    // …and the chrome round the content: the closing line, the message's time, the tool's row.
    expect(selects(document.querySelector(".msg-run")!)).toBe("none");
    expect(selects(document.querySelector(".msg-user-at")!)).toBe("none");
    expect(selects(screen.getByRole("button", { name: /Bash tool call/ }))).toBe("none");
    // The column itself is not content: a drag that starts beside a message selects nothing.
    expect(selects(document.querySelector(".transcript-col")!)).toBe("none");
  });

  it("keeps a diff's lines selectable", () => {
    const patch: FileDiff = { path: "a.ts", oldPath: null, staged: false, binary: false, truncated: false, truncatedReason: null, additions: 1, deletions: 1,
      hunks: [{ header: "", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
        { kind: "del", text: "old line", oldLine: 1, newLine: null },
        { kind: "add", text: "new line", oldLine: null, newLine: 1 },
      ] }] };
    render(<UnifiedPatch patch={patch} />);
    expect(selects(document.querySelector(".diff-text")!)).toBe("text");
  });

  it("lets a surface of content join by attribute, so a new one needs no new name in the stylesheet", () => {
    const region = document.body.appendChild(document.createElement("div"));
    region.setAttribute("data-selectable", "");
    const words = region.appendChild(document.createElement("p"));
    expect(selects(words)).toBe("text");
    const press = region.appendChild(document.createElement("button"));
    expect(selects(press)).toBe("none");
  });
});

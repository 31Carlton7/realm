import type { Block } from "../panes/session/transcript-model";

/**
 * What the panel's answer pill says: the last question as its title and what came back under it, as
 * ChatGPT's companion shows a reply over its bar. The whole exchange is one click away (expand).
 */
export type AnswerPill = { title: string; answer: string; state: "working" | "done" | "failed" };

/** Markdown's marks off, and the lines run together: the pill is two lines of plain words. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function answerPill(blocks: readonly Block[], running: boolean): AnswerPill | null {
  let asked = -1;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.kind === "user") { asked = i; break; }
  if (asked < 0) return null;
  const question = blocks[asked] as Extract<Block, { kind: "user" }>;
  const title = plain(question.text) || "Attachment";
  const after = blocks.slice(asked + 1);
  const failure = after.findLast((b) => b.kind === "error");
  const reply = after.filter((b): b is Extract<Block, { kind: "assistant" }> => b.kind === "assistant").map((b) => plain(b.text)).filter(Boolean).join(" ");
  if (!running && failure) return { title, answer: failure.message, state: "failed" };
  if (running) return { title, answer: reply || "Working", state: "working" };
  return { title, answer: reply, state: "done" };
}

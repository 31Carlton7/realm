import { basenameOf } from "@realm/contracts";
import type { Block, Transcript } from "./transcript-model";
import { toolSummary } from "./tool-summary";

/**
 * A session as a Markdown document.
 *
 * The rule the whole file follows: export what the transcript SHOWS, not what the wire carried. A
 * dump of `session_events` would be more complete and far less useful — the reader exporting a
 * session wants the thing they were reading, in an order and a shape they can paste into an issue,
 * a review or a note. So this is the transcript's own vocabulary (messages, thinking, tools, plans,
 * errors) flattened into headings and blockquotes.
 *
 * Two things are deliberately NOT lossless:
 *
 *  - **Tool bodies.** A tool's full input and result can be megabytes of file contents, and forty of
 *    them would bury the conversation the export exists to carry. Each call gets the one line the
 *    card's own header shows (`toolSummary`), plus whether it failed. Someone who needs the payload
 *    needs the session, not a document.
 *  - **Streaming state.** A message still being written is exported as it stands, with no marker.
 *    Its text is the text; that it is not finished is a fact about now, not about the document.
 */
export function exportSessionMarkdown(input: {
  title: string;
  transcript: Transcript;
  agentLabel: string;
  model: string | null;
  cwd: string | null;
  /** When the export was taken. Passed in rather than read here so the output is testable. */
  now: number;
}): string {
  const { transcript, now } = input;
  const out: string[] = [`# ${input.title}`, ""];

  // A front-matter-ish preamble in prose, not YAML: this is a document to read, and the four facts
  // that change what the transcript MEANS — who ran it, on what, where, and when it was taken — are
  // exactly the ones a pasted excerpt loses.
  const facts = [
    `**Agent:** ${input.agentLabel}`,
    input.model ? `**Model:** ${input.model}` : null,
    input.cwd ? `**Workspace:** \`${input.cwd}\`` : null,
    `**Exported:** ${new Date(now).toLocaleString()}`,
  ].filter(Boolean) as string[];
  out.push(facts.join("  \n"), "");

  const u = transcript.usage;
  if (u.numTurns > 0 || u.costUsd > 0) {
    const bits = [
      u.numTurns > 0 ? `${u.numTurns} turn${u.numTurns === 1 ? "" : "s"}` : null,
      u.costUsd > 0 ? `$${u.costUsd.toFixed(u.costUsd >= 0.01 ? 2 : 3)}` : null,
    ].filter(Boolean);
    out.push(`_${bits.join(" · ")}_`, "");
  }

  out.push("---", "");
  transcript.blocks.forEach((b, i) => {
    const section = sectionFor(b);
    if (!section) return;
    out.push(section);
    // Consecutive tool calls are ONE list, so no blank line goes between them: a blank line makes it
    // a loose list, and every bullet renders in its own paragraph with a run of tools spread down
    // the page. Everything else is a section and gets its air.
    const next = transcript.blocks[i + 1];
    if (!(b.kind === "tool" && next?.kind === "tool")) out.push("");
  });
  // One trailing newline, the way every other text file ends.
  return `${out.join("\n").trimEnd()}\n`;
}

function sectionFor(b: Block): string | null {
  switch (b.kind) {
    case "user": {
      const lines: string[] = [b.from ? `## Asked by ${b.from.title}` : "## User"];
      if (b.attachments?.length) lines.push("", `_Attached: ${b.attachments.map((a) => basenameOf(a.path)).join(", ")}_`);
      if (b.text) lines.push("", b.text);
      return lines.join("\n");
    }
    case "assistant":
      // An empty assistant block is a message that has arrived but has no text yet. A heading over
      // nothing reads as a lost answer, so it is skipped rather than exported as a blank section.
      return b.text ? `## Assistant\n\n${b.text}` : null;
    // Folded, not dropped: thinking is genuinely secondary — it is behind a disclosure in the app —
    // and a details block is the Markdown that keeps that relationship in a document.
    case "thinking":
      return b.text ? `<details>\n<summary>Thinking</summary>\n\n${b.text}\n\n</details>` : null;
    case "tool": {
      const summary = toolSummary(b.name, b.input);
      const failed = b.result?.isError ? " — failed" : "";
      const pending = b.result === null ? " — no result" : "";
      return `- \`${b.name}\`${summary ? ` ${inlineCode(summary)}` : ""}${failed}${pending}`;
    }
    case "plan": {
      const lines = ["## Plan"];
      if (b.text) lines.push("", b.text);
      // A real task list, so the export renders as one on GitHub and in every editor that reads
      // them — the checklist's statuses are the point of exporting a plan at all.
      if (b.steps?.length) lines.push("", ...b.steps.map((s) => `- [${s.status === "completed" ? "x" : " "}] ${s.text}${s.status === "in_progress" ? " _(in progress)_" : ""}`));
      return lines.join("\n");
    }
    case "error": return `> **Error:** ${b.message.split("\n").join("\n> ")}`;
    // The elapsed-time line is a fact about watching the session happen, not about what it produced.
    case "run": return null;
  }
}

/** A one-line summary as inline code, with any backticks in it neutralised — a command containing a
 *  backtick would otherwise close the span and spill markup into the document. */
function inlineCode(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (!one) return "";
  // One backtick unless the text contains a run of them, in which case the fence has to be longer
  // than the longest run. `Math.max(1, ...[])` is 1 and would fence a plain string in doubles.
  const runs = [...one.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = "`".repeat(runs.length > 0 ? Math.max(...runs) + 1 : 1);
  return `${fence}${one.startsWith("`") ? " " : ""}${one}${one.endsWith("`") ? " " : ""}${fence}`;
}

/** A filename for the export: the session's title, reduced to something every filesystem accepts.
 *  Never empty — an untitled session still gets a name rather than a bare extension. */
export function exportFileName(title: string, now: number): string {
  const stem = title.trim().replace(/[/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 60).trim() || "Session";
  const d = new Date(now);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${stem} ${stamp}.md`;
}

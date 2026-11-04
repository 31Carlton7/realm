/**
 * What voice mode says of an agent's reply, a sentence at a time while it streams.
 *
 * Prose is read as written, less its markdown. What only a screen can carry — a fenced block, a diff,
 * a table — is skipped and said in one line instead, so the person knows to look. A sentence goes the
 * moment its end is seen, which is what lets the first one be heard while the agent is still writing
 * the rest.
 */

export const CODE_MENTION = "I put the code in the chat.";
export const DIFF_MENTION = "I put the diff in the chat.";
export const TABLE_MENTION = "There's a table in the chat.";

type LineKind = "prose" | "item" | "heading" | "quote" | "fence" | "table" | "rule" | "blank";

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE_ROW = /^\s*\|/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^\s*([-*+]|\d{1,3}[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const QUOTE = /^\s{0,3}>\s?/;

/** Words a period follows without ending the sentence. */
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|cf)\.$/i;

/** The kind of a line, or null while too little of it has arrived to say: a line that has only
 *  reached "`" or "-" may yet be a fence or a list item. */
function lineKind(line: string, complete: boolean): LineKind | null {
  if (!line.trim()) return complete ? "blank" : null;
  // A fence's language is the rest of its line, and "diff" is said differently from code: wait for it.
  if (FENCE.test(line)) return complete ? "fence" : null;
  if (TABLE_ROW.test(line)) return "table";
  if (complete && RULE.test(line)) return "rule";
  if (ITEM.test(line)) return "item";
  if (HEADING.test(line)) return "heading";
  if (QUOTE.test(line)) return "quote";
  const head = line.trimStart();
  if (!complete && head.length < 4 && /^[`~|#>*+\-_\d]/.test(head)) return null;
  return "prose";
}

function contentOf(line: string, kind: LineKind): string {
  if (kind === "item") return line.replace(ITEM, "");
  if (kind === "heading") return line.replace(HEADING, "").replace(/\s#+\s*$/, "");
  if (kind === "quote") return line.replace(QUOTE, "");
  return line;
}

/**
 * Splits off every sentence whose end has been seen: terminal punctuation (and any closing quote,
 * bracket or emphasis) followed by a space. The rest is what is still being written.
 */
export function takeSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const end = /[.!?…]+["'”’)\]*_`]*(?=\s)/g;
  let from = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const stop = m.index + m[0].length;
    const candidate = text.slice(from, stop);
    if (ABBREVIATIONS.test(text.slice(Math.max(from, m.index - 8), m.index + 1))) continue;
    sentences.push(candidate.trim());
    from = stop;
  }
  return { sentences: sentences.filter(Boolean), rest: text.slice(from).replace(/^\s+/, "") };
}

/** A sentence as it should sound: links as their words, a path as its file's name, no markup. */
export function speakable(sentence: string): string {
  const text = sentence
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "a link")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]+)`/g, (_, code: string) => (/^[\w.@~-]*\/[\w./@~-]+$/.test(code) ? code.split("/").filter(Boolean).pop() ?? code : code))
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

/**
 * Reads one reply. `feed` takes the reply's whole text so far — the transcript keeps it whole — and
 * returns what has become sayable since the last call. Pass `done` once the reply has settled to
 * have the last unfinished sentence said too.
 */
export class ReplyReader {
  /** Where the line being read starts in the reply. */
  private at = 0;
  /** How much of that line's content has already been said. */
  private taken = 0;
  private kind: LineKind | null = null;
  private fence: string | null = null;
  /** A paragraph's words carried across a line break, not yet a whole sentence. */
  private carried = "";
  private lastMention: string | null = null;
  private out: string[] = [];

  feed(reply: string, done = false): string[] {
    for (;;) {
      const nl = reply.indexOf("\n", this.at);
      const complete = nl >= 0 || done;
      const line = reply.slice(this.at, nl >= 0 ? nl : reply.length);
      this.read(line, complete);
      if (nl < 0) break;
      this.at = nl + 1;
      this.taken = 0;
      this.kind = null;
    }
    if (done) this.flush();
    const said = this.out;
    this.out = [];
    return said;
  }

  private read(line: string, complete: boolean): void {
    if (this.fence !== null) {
      // The line that opened the fence is still `kind` "fence"; any other line starting with the
      // marker closes it.
      if (this.kind !== "fence" && complete && line.trim().startsWith(this.fence)) this.fence = null;
      return;
    }
    if (this.kind === null) {
      const kind = lineKind(line, complete);
      if (kind === null) return;
      this.begin(kind, line);
    }
    const kind = this.kind!;
    if (kind === "fence" || kind === "table" || kind === "rule" || kind === "blank") return;
    const content = contentOf(line, kind);
    const fresh = content.slice(this.taken);
    const text = this.carried ? `${this.carried} ${fresh.trimStart()}` : fresh;
    const { sentences, rest } = takeSentences(complete ? `${text} ` : text);
    for (const s of sentences) this.say(s);
    if (sentences.length) { this.carried = ""; this.taken = content.length - (complete ? rest.trimEnd() : rest).length; }
    if (!complete) return;
    // A whole line: prose may go on in the next line of its paragraph; an item or a heading is said
    // on its own.
    if (kind === "prose" || kind === "quote") this.carried = rest.trimEnd();
    else { this.carried = rest.trim(); this.flush(); }
  }

  /** What a line's first characters decide: a fence or a table interrupts the paragraph and is
   *  mentioned once; an item or a heading starts its own sentence. */
  private begin(kind: LineKind, line: string): void {
    this.kind = kind;
    if (kind === "prose" || kind === "quote") return;
    this.flush();
    if (kind === "fence") {
      const [, marker, lang] = FENCE.exec(line)!;
      this.fence = marker!;
      this.mention(/^(diff|patch)$/i.test(lang ?? "") ? DIFF_MENTION : CODE_MENTION);
    } else if (kind === "table") {
      this.mention(TABLE_MENTION);
    }
  }

  private flush(): void {
    const left = this.carried.trim();
    this.carried = "";
    if (left) this.say(left);
  }

  private say(sentence: string): void {
    const text = speakable(sentence);
    if (!text) return;
    this.out.push(text);
    this.lastMention = null;
  }

  /** Two code blocks with nothing said between them are one mention, not two. */
  private mention(text: string): void {
    if (this.lastMention === text) return;
    this.out.push(text);
    this.lastMention = text;
  }
}

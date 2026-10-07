/* The hint FIELD of a session's recap: its ceiling and its cleanup. The call that fills it lives
   in `generate-session-recap.ts`, which answers this field and the summary together. */

/**
 * The ceiling on a hint, and a hard one.
 *
 * It is a placeholder inside the prompter's one-line box, and it ellipsizes rather than wrapping —
 * so a sentence that runs past this is not merely long, it is invisible past the cut. The model is
 * told the number too: a budget it can write to is what keeps the clip from ever being reached.
 */
export const HINT_MAX = 64;

/**
 * What the model returned, made safe to put in the box — or a throw.
 *
 * A refusal and an empty answer are the same outcome to the caller ("keep the deterministic one"), so
 * both leave by the same door. Everything else is trimmed of the wrappers a model adds when it is
 * being helpful: surrounding quotes, a leading bullet, a trailing newline.
 */
export function cleanHint(raw: string): string {
  let text = raw.trim().split("\n")[0]?.trim() ?? "";
  // Models offer `"Write tests for it."` and `- Write tests for it.` about equally often.
  text = text.replace(/^[-*•]\s*/, "").replace(/^["'“‘]|["'”’]$/g, "").trim();
  if (!text || /^none\.?$/i.test(text)) throw new Error("prompt hint declined");
  // Past the ceiling is a brief the model ignored. Clipping mid-word would put an ellipsis in the
  // user's outgoing message, so the answer is discarded rather than salvaged.
  if (text.length > HINT_MAX) throw new Error(`prompt hint too long: ${text.length} > ${HINT_MAX}`);
  return text;
}

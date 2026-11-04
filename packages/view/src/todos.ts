/** One item of TodoWrite's list. `activeForm` is optional in practice, so its absence is null. */
export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string | null };

const str = (o: Record<string, unknown>, k: string): string | null => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : null);

/** TodoWrite's list, or null if the payload is not the shape it documents. The desktop's plan strip
 *  and a phone's both read it here, so the two never disagree about what the plan is. */
export function parseTodos(input: Record<string, unknown>): Todo[] | null {
  const todos = input["todos"];
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const out: Todo[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") return null;
    const bag = t as Record<string, unknown>;
    const content = str(bag, "content");
    const status = str(bag, "status");
    if (content === null || (status !== "pending" && status !== "in_progress" && status !== "completed")) return null;
    out.push({ content, status, activeForm: str(bag, "activeForm") });
  }
  return out;
}

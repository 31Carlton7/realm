/** A sentence with its commands set as code. Realm's hints mark a command with backticks
 *  (`AGENT_LOGIN_HINTS`, `AGENT_NOTES`), which read as stray punctuation printed raw. */
export const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/** The same sentence for a tooltip, which has no code face. */
export const plainCode = (text: string) => text.replace(/`/g, "");

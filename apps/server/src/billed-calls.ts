import { generateSessionRecap, generateSessionTitle } from "@realm/adapters";

/**
 * The server's own billed model calls — a model-written sidebar title on a session's first message,
 * and a recap when a turn settles — or none at all.
 *
 * None while the scripted agent is enabled. That flag is how every live check and capture boots the
 * BUILT app (`REALM_ENABLE_FAKE_AGENT=1`, "offline dev" in `defaultAdapters`), and those boot this
 * entry rather than a bare `createApp` — so without this, each one sent its first message to a model
 * on the user's own account and left a transcript for a scratch folder in `~/.claude/projects`,
 * while `SessionsDeps.titleGenerator` promised a harness would never make that call. A harness gets
 * the heuristic first-line title instead, which is all any live check reads.
 */
export function billedGenerators(env: NodeJS.ProcessEnv = process.env): { titleGenerator?: typeof generateSessionTitle; summaryGenerator?: typeof generateSessionRecap } {
  return env.REALM_ENABLE_FAKE_AGENT === "1" ? {} : { titleGenerator: generateSessionTitle, summaryGenerator: generateSessionRecap };
}

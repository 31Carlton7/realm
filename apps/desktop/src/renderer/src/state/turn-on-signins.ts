import type { AgentSigninsStatus, SecurityCodesStatus } from "@realm/contracts";

/** Agent sign-ins on, then Security codes, which a sign-in's second step needs. Settings' switch and
 *  the fill card's Turn on sign-ins both come here, and neither waits on the codes' status to load. */
export async function turnOnSignins(): Promise<{ signins: AgentSigninsStatus | null; codes: SecurityCodesStatus | null }> {
  const api = window.realm?.credentials;
  const signins = (await api?.setSignins?.(true)) ?? null;
  if (!signins?.enabled) return { signins, codes: null };
  const codes = (await api?.setCodes?.(true).catch(() => null)) ?? null;
  return { signins, codes };
}

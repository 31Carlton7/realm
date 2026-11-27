import type { AgentSigninsStatus, SecurityCodesStatus } from "@realm/contracts";

/**
 * Turns main's agent sign-ins switch on, then Security codes, which a sign-in's second step needs.
 * Settings' switch and the fill card's Turn on sign-ins both come here, so neither can leave codes
 * off. Codes are asked for whether or not their status has loaded: main answers an on switch as on.
 */
export async function turnOnSignins(): Promise<{ signins: AgentSigninsStatus | null; codes: SecurityCodesStatus | null }> {
  const api = window.realm?.credentials;
  const signins = (await api?.setSignins?.(true)) ?? null;
  if (!signins?.enabled) return { signins, codes: null };
  const codes = (await api?.setCodes?.(true).catch(() => null)) ?? null;
  return { signins, codes };
}

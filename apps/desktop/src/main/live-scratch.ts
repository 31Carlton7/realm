/**
 * A live check's window must never be mistaken for the user's Realm. On 2026-10-12 a word typed into
 * a scratch copy that had taken focus ran a real, billed turn, so a scratch window opens without
 * focus, cannot take it, lets clicks through, and says what it is in its title and on the page.
 *
 * Honoured ONLY in an unpackaged app booted as a harness (`REALM_ENABLE_FAKE_AGENT=1` with
 * `REALM_LIVE_SCRATCH=1`). A packaged Realm ignores it whatever its environment says.
 */
export const SCRATCH_TITLE = "SCRATCH — not your Realm";

const BANNER_SCRIPT = `(() => {
  if (document.getElementById('live-scratch-banner')) return;
  const d = document.createElement('div');
  d.id = 'live-scratch-banner';
  d.textContent = 'SCRATCH COPY — NOT YOUR REALM';
  d.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:2147483647;background:#c00;color:#fff;font:700 13px system-ui;text-align:center;padding:3px;pointer-events:none';
  document.body.append(d);
})()`;

export type LiveScratch = {
  windowOptions: { show: false; focusable: false; title: string };
  bannerScript: string;
};

export function liveScratch(d: { packaged: boolean; env: Record<string, string | undefined> }): LiveScratch | null {
  if (d.packaged) return null;
  if (d.env.REALM_ENABLE_FAKE_AGENT !== "1" || d.env.REALM_LIVE_SCRATCH !== "1") return null;
  return { windowOptions: { show: false, focusable: false, title: SCRATCH_TITLE }, bannerScript: BANNER_SCRIPT };
}

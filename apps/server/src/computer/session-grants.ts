import { COMPUTER_FORBIDDEN_BUNDLE_IDS } from "@realm/contracts";

export type GrantedApp = { bundleId: string; name: string };

const FORBIDDEN: ReadonlySet<string> = new Set(COMPUTER_FORBIDDEN_BUNDLE_IDS);

/**
 * Computer use for ONE session and named apps, given by the user mentioning them — `@Messages` in a
 * message they sent.
 *
 * What a mention is, and is not. It is consent to USE that app in that session: the `realm-computer`
 * tools appear for the session even in a space that never switched them on, and they reach that app
 * and no other — a snapshot, an act or a walk naming anything else is refused before the helper is
 * asked. It is not a bypass: every act still goes through the permission card keyed per app, which
 * `bypassPermissions` does not skip either (`promptUnderBypass`), a read-only mode still refuses to
 * act, and the forbidden apps stay forbidden — none can be granted here at all.
 *
 * In memory, per session, and never written anywhere. It ends when the session is deleted or the
 * server stops (`release`, from `SessionService.delete` and `closeAll`) — the same lifetime as the
 * broker's "allow for this session" answers, which is what a resumed session re-earns. It never
 * becomes a space setting: the space's own switch and its allowed-apps list are untouched by it.
 */
export class ComputerSessionGrants {
  private readonly bySession = new Map<string, Map<string, string>>();

  /** Grant these apps to this session. Answers whether that added any, which is when the session's
   *  tool list has changed and its agent should be told to read it again. */
  grant(sessionId: string, apps: readonly GrantedApp[]): boolean {
    let granted = this.bySession.get(sessionId);
    let added = false;
    for (const app of apps) {
      if (!app.bundleId || FORBIDDEN.has(app.bundleId)) continue;
      if (!granted) { granted = new Map(); this.bySession.set(sessionId, granted); }
      if (!granted.has(app.bundleId)) added = true;
      granted.set(app.bundleId, app.name);
    }
    return added;
  }

  /** The apps this session may drive because the user mentioned them, in the order they were. */
  apps(sessionId: string): GrantedApp[] {
    return [...(this.bySession.get(sessionId) ?? new Map<string, string>())].map(([bundleId, name]) => ({ bundleId, name }));
  }

  /** The session is gone or the server is stopping: its grants go with it. */
  release(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

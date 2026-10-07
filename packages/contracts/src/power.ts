/**
 * Whether Realm keeps the Mac from sleeping while an agent is working.
 *
 * Off unless asked for: a laptop that will not sleep is a battery the user did not agree to spend.
 * On, main holds Electron's `prevent-app-suspension` blocker for exactly as long as a session is
 * running — the system stays awake, the display may still sleep, and the moment the last turn ends
 * the Mac is free to sleep again (`main/sleep-guard.ts`). A session waiting on the user is not
 * working: it loses nothing by the Mac sleeping, and an unanswered question is not a reason to keep
 * a laptop warm overnight.
 */
export const POWER_PREVENT_SLEEP_KEY = "power.preventSleep";
export const POWER_PREVENT_SLEEP_DEFAULT = false;

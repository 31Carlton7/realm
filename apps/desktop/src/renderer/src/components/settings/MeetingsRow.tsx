import { useEffect } from "react";
import type { CalendarAccess } from "@realm/contracts";
import { useApp } from "../../state/store";

/** What is missing, and the one thing that can be done about it. macOS asks once: after a refusal
 *  only System Settings changes the answer, and a restricted Mac (a profile, Screen Time) has no
 *  answer the person can change. */
const WITHOUT_ACCESS: Record<Exclude<CalendarAccess, "full">, { says: string; action: "ask" | "settings" | null }> = {
  notDetermined: { says: "Realm has not asked macOS for your calendar yet, so no meeting opens.", action: "ask" },
  denied: { says: "macOS is not letting Realm read your calendar, so no meeting opens.", action: "settings" },
  writeOnly: { says: "macOS lets Realm add events but not read them, so no meeting opens.", action: "settings" },
  restricted: { says: "This Mac does not let apps read the calendar, so no meeting opens.", action: null },
};

/**
 * Settings ▸ General ▸ Meetings: open a calendar meeting's link when it starts. The line under the
 * label is what the switch also does (the notification) until calendar access is missing; then it
 * says so, beside the button that asks macOS or opens System Settings.
 */
export function MeetingsRow() {
  const opensMeetings = useApp((s) => s.opensMeetings);
  const setOpensMeetings = useApp((s) => s.setOpensMeetings);
  const access = useApp((s) => s.calendarAccess);
  const refreshCalendarAccess = useApp((s) => s.refreshCalendarAccess);
  const watchCalendarAccess = useApp((s) => s.watchCalendarAccess);
  const askForCalendar = useApp((s) => s.askForCalendar);
  const openCalendarSettings = useApp((s) => s.openCalendarSettings);
  const startsAssistant = useApp((s) => s.startsAssistant);
  const setStartsAssistant = useApp((s) => s.setStartsAssistant);
  const run = useApp((s) => s.run);
  useEffect(() => {
    void run(() => refreshCalendarAccess());
    // A grant changed in System Settings is seen when the person comes back to this window.
    const onFocus = () => void run(() => refreshCalendarAccess());
    window.addEventListener("focus", onFocus);
    const unwatch = watchCalendarAccess();
    return () => { window.removeEventListener("focus", onFocus); unwatch(); };
  }, [run, refreshCalendarAccess, watchCalendarAccess]);

  const missing = opensMeetings && access !== null && access !== "full" ? WITHOUT_ACCESS[access] : null;
  return (
    <ul className="settings-list">
      <li className="settings-row" data-setting="open-meetings"
        title="For calendar events with a Zoom, Google Meet, Microsoft Teams, Webex or FaceTime link that you have not declined. The link opens in the app or browser macOS gives it to. A meeting already more than five minutes in is left alone.">
        <div className="settings-row-main">
          <span className="settings-row-name">Open the meeting when it starts</span>
          <span className="settings-row-detail">{missing ? missing.says : "With a notification two minutes before"}</span>
        </div>
        {missing?.action === "ask" && (
          <button type="button" className="btn" onClick={() => run(() => askForCalendar())}>Ask macOS</button>
        )}
        {missing?.action === "settings" && (
          <button type="button" className="btn" onClick={() => run(() => openCalendarSettings())}>Open System Settings</button>
        )}
        <input type="checkbox" role="switch" className="switch" aria-label="Open the meeting when it starts"
          checked={opensMeetings}
          onChange={(e) => run(() => setOpensMeetings(e.target.checked))} />
      </li>
      <li className="settings-row" data-setting="start-assistant"
        title="When a calendar meeting starts, or Zoom, Teams, FaceTime, Slack, Discord or a browser in a call starts using the microphone, the quick chat panel opens on the meeting assistant and it starts listening. The red mark shows in the panel and the menu bar the whole time.">
        <div className="settings-row-main">
          <span className="settings-row-name">Start the assistant when a call starts</span>
          <span className="settings-row-detail">Only after you have accepted the assistant's first-run sheet</span>
        </div>
        <input type="checkbox" role="switch" className="switch" aria-label="Start the assistant when a call starts"
          checked={startsAssistant}
          onChange={(e) => run(() => setStartsAssistant(e.target.checked))} />
      </li>
    </ul>
  );
}

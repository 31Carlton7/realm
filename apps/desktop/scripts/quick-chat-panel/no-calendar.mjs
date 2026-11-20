// Stands in for the `meetingwatch` helper in the quick chat panel's live checks. The app starts
// `meetingwatch calendar` at launch, and the real one reads the calendar of whoever runs the check.
// This one says access was never asked for and then waits for its stdin to close, as the helper does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `env` goes to `launchLiveApp`; `remove` deletes the stand-in once the app has stopped. */
export function noCalendar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realm-no-calendar-"));
  const helper = path.join(dir, "meetingwatch");
  fs.writeFileSync(helper, `#!/bin/bash\necho '{"access":"notDetermined"}'\ncat > /dev/null\n`, { mode: 0o755 });
  return { env: { REALM_MEETINGWATCH_BIN: helper }, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

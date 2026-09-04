import { execFile } from "node:child_process";
import { userInfo } from "node:os";

/**
 * The person's first name, for `system.info.userName` — the hero prompter greets by name when it
 * knows one ("Good evening, Carlton."), and falls back to name-less phrasing when it does not.
 *
 * macOS keeps the real name in the directory record, which `id -F` prints ("Carlton Aikins"); no
 * other platform answers that flag, so everywhere else this is simply unknown. An account whose
 * real name was never set reports the short username back — a greeting that says "Good evening,
 * carltonaikins" is worse than one that says nothing, so that case is unknown too.
 */
export function userFirstName(): Promise<string> {
  return new Promise((resolve) => {
    execFile("id", ["-F"], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? "" : firstName(stdout, userInfo().username));
    });
  });
}

/** The leading word of a full name, unless the record is just the login name wearing a full name's
 *  hat. Only the WHOLE record is compared: plenty of people log in as their first name, and "Ada"
 *  is still the right way to greet the owner of `ada` / "Ada Lovelace". */
export function firstName(fullName: string, username: string): string {
  const full = fullName.trim();
  if (!full || full.toLowerCase() === username.toLowerCase()) return "";
  return full.split(/\s+/)[0]!;
}

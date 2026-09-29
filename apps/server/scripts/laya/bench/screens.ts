/**
 * Which crawled reads become benchmark screens, and under which app.
 *
 * A screen is a crawl snapshot (`screens/<file>.json`) or one side of a recorded step
 * (`pairs/<file>.json`, `before` or `after`) — a snapshot taken while an app was still coming up can
 * hold two apps' elements at once, and the step recorded a moment later is the clean read of the same
 * screen. Alerts that iOS draws for an app report no app of their own, so every screen names its app
 * here rather than trusting the read.
 */
export type ScreenSource = { id: string; app: string; from: string };

const crawl = (app: string, ...files: string[]): ScreenSource[] => files.map((f) => ({ id: f, app, from: `screens/${f}` }));
const pair = (id: string, app: string, file: string, side: "before" | "after"): ScreenSource => ({ id, app, from: `pairs/${file}#${side}` });

export const SCREENS: ScreenSource[] = [
  { id: "home", app: "Home Screen", from: "screens/home-1" },

  ...crawl("Settings",
    "settings-root-top", "settings-root-3", "settings-accessibility-2", "settings-actionbutton", "settings-appearance",
    "settings-apps", "settings-apps-2", "settings-autofill", "settings-camera", "settings-displayzoom", "settings-gamecenter",
    "settings-homescreen", "settings-language", "settings-liquidglass", "settings-location", "settings-privacy-1",
    "settings-privacy-2", "settings-privacy-3", "settings-safari-1", "settings-safari-2", "settings-safari-3", "settings-safari-4",
    "settings-screencapture", "settings-screentime", "settings-search", "settings-search-suggestions", "settings-signin-email",
    "settings-signin-password-filled", "settings-signin-result", "settings-signin-sheet", "settings-siri", "settings-standby",
    "settings-textsize", "settings-tracking", "settings-vpn"),
  { id: "settings-general", app: "Settings", from: "screens/settings-general-2" },
  pair("settings-about", "Settings", "v-general-about", "after"),
  pair("settings-keyboard", "Settings", "v-general-keyboard", "after"),
  pair("settings-fonts", "Settings", "v-general-fonts", "after"),
  pair("settings-textreplace", "Settings", "v-kb-textrepl", "after"),
  pair("settings-clear-history", "Settings", "v-safari-clear", "after"),
  pair("settings-textreplace-edit", "Settings", "v-tr-edit", "after"),
  pair("settings-textreplace-delete", "Settings", "v-tr-remove", "after"),
  pair("settings-signin-password", "Settings", "v-signin-continue", "after"),

  ...crawl("Safari",
    "safari-start", "safari-pagemenu", "safari-share", "safari-tabs", "safari-private", "safari-private-start", "safari-newtab",
    "safari-history", "safari-readinglist", "safari-bookmarks", "safari-bookmarks-more", "safari-address", "safari-typed"),

  pair("maps-permission", "Maps", "v-maps-allow", "before"),
  ...crawl("Maps", "maps-ads-notice", "maps-root", "maps-modes", "maps-satellite", "maps-search", "maps-coffee", "maps-place",
    "maps-safety-alert", "maps-directions"),

  ...crawl("Calendar", "calendar-whatsnew", "calendar-permission", "calendar-notifications", "calendar-root", "calendar-new-event",
    "calendar-discard", "calendar-month", "calendar-calendars"),

  pair("contacts-card", "Contacts", "v-contacts-back", "before"),
  pair("contacts-anna", "Contacts", "v-contacts-anna", "after"),
  ...crawl("Contacts", "contacts-list", "contacts-edit", "contacts-edit-2", "contacts-delete-confirm"),

  pair("messages-root", "Messages", "v-msg-thread", "before"),
  ...crawl("Messages", "messages-thread", "messages-compose", "messages-add"),

  pair("photos-root", "Photos", "v-photos-dontallow", "after"),
  ...crawl("Photos", "photos-whatsnew", "photos-photo", "photos-info", "photos-delete-confirm", "photos-edit", "photos-collections"),

  ...crawl("Files", "files-root", "files-browse", "files-more"),

  ...crawl("Reminders", "reminders-icloud-alert", "reminders-root", "reminders-lists", "reminders-new", "reminders-list",
    "reminders-more", "reminders-delete-alert"),

  pair("shortcuts-whatsnew", "Shortcuts", "v-sc-continue", "before"),
  ...crawl("Shortcuts", "shortcuts-root", "shortcuts-library", "shortcuts-gallery"),

  ...crawl("Health", "health-welcome", "health-setup-1", "health-setup-2", "health-setup-3", "health-notif-alert", "health-summary",
    "health-browse", "health-heart", "health-sharing"),

  ...crawl("Wallet", "wallet-root", "wallet-error", "wallet-orders", "wallet-more"),
  ...crawl("Passwords", "passwords-welcome", "passwords-root", "passwords-wifi", "passwords-new"),
  ...crawl("News", "news-root", "news-puzzles", "news-audio"),
  ...crawl("Fitness", "fitness-root", "fitness-workout", "fitness-buddy", "fitness-workouts"),
  ...crawl("Watch", "watch-root", "watch-faces"),
  ...crawl("Remote", "remote-root"),
  ...crawl("Preview", "preview-root"),
];

/**
 * Elements left out of every stored screen and pair: other people's words (a map's reviews, the
 * day's headlines, which the benchmark has no use for) and the one app on the device that is not
 * Apple's. What is left is what iOS itself draws on a fresh simulator.
 */
export function dropElement(app: string, e: { id?: string | null; label: string; role: string }): boolean {
  if (/PlaceReviewPlatter/.test(e.id ?? "") || /· .+ ago, "\d(\.\d)? stars?"/.test(e.label)) return true;
  if (/^Versed$/.test(e.label.trim())) return true;
  if (app === "News" && /generic/i.test(e.role) && e.label.length > 60) return true;
  return false;
}

/** The apps kept out of every training set, whole, and the apps model selection is done on. */
export const HELDOUT_APPS = ["Maps", "Health", "Contacts", "Files", "Passwords"];
export const VALIDATION_APPS = ["Reminders", "Watch"];
/** Of every other app's cases: this share held out, then this share for validation. */
export const HELDOUT_SHARE = 0.15;
export const VALIDATION_SHARE = 0.12;

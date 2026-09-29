/**
 * `verify` cases: a step really taken on the simulator (`pairs/<id>.json`, the screen read before and
 * after it), what the step was for, and whether it did that.
 *
 * `ok` is a step that did what it was for. The rest are the ways a step fails: `no-change` (the tap
 * landed on nothing, or on a label), `alert` (an error came up instead), `wrong-screen` (something else
 * opened — the wrong row, or the search bar floating over the right one), `interrupted` (a prompt or
 * sheet stood between the step and its goal), `confirm` (the step only asked "are you sure?"), and
 * `partial` (it opened the way to the goal without reaching it). A `wrong-screen` case may reuse a step
 * recorded for another intent: the transition is real, only the stated goal is not what happened.
 *
 * Left out: steps whose change the screen diff cannot see (typing into a field with no label reads as
 * "No change" whatever happened), and steps where the read after landed mid-animation.
 */
export type VerifyKind = "ok" | "no-change" | "alert" | "wrong-screen" | "interrupted" | "confirm" | "partial";
export type VerifyCase = { pair: string; intent: string; achieved: boolean; kind: VerifyKind };

const ok = (pair: string, intent: string): VerifyCase => ({ pair, intent, achieved: true, kind: "ok" });
const fail = (kind: Exclude<VerifyKind, "ok">, pair: string, intent: string): VerifyCase => ({ pair, intent, achieved: false, kind });

export const VERIFY: VerifyCase[] = [
  // Settings
  ok("v-about-back", "go back to General settings"),
  ok("v-app-liquidglass", "open the Liquid Glass options"),
  ok("v-app-textsize", "open the text size setting"),
  fail("wrong-screen", "v-app-textsize", "open Display Zoom"),
  ok("v-app-zoom", "open display zoom options"),
  ok("v-general-about", "see which iOS version this phone runs"),
  ok("v-general-autofill", "choose which app fills in my saved passwords"),
  ok("v-general-dictionary", "manage dictionaries for looking up words"),
  ok("v-general-fonts", "see installed fonts"),
  fail("wrong-screen", "v-general-fonts", "open Keyboard settings"),
  ok("v-general-keyboard", "change keyboard settings like autocorrect"),
  ok("v-general-lang", "change the phone's language or region"),
  ok("v-general-screencap", "change screenshot settings"),
  ok("v-general-vpn", "open VPN & Device Management"),
  ok("v-kb-autocap-on", "turn auto-capitalization back on"),
  ok("v-kb-autocorrect-off-2", "turn off autocorrect"),
  fail("no-change", "v-kb-autocorrect-off", "turn off autocorrect"),
  ok("v-kb-autocorrect-on", "turn autocorrect back on"),
  fail("no-change", "v-kb-haptic-on", "make the keyboard vibrate when I type"),
  fail("no-change", "v-kb-heading-nochange", "turn on caps lock"),
  ok("v-kb-keyboards", "open the list of keyboards"),
  fail("no-change", "v-kb-sound-back", "turn keyboard clicks back on"),
  ok("v-kb-textrepl", "open text replacement"),
  fail("wrong-screen", "v-kb-wrong-predictive", "turn off autocorrect"),
  fail("no-change", "v-kb-wrong-sound", "turn off predictive text suggestions"),
  fail("no-change", "v-nc-general-bottom", "scroll further down the General list"),
  fail("no-change", "v-nc-general-desc", "open the About page"),
  fail("no-change", "v-nc-general-heading", "check the iOS version"),
  ok("v-nc-settings-general", "open General settings"),
  fail("no-change", "v-nc-settings-heading", "open General settings"),
  fail("no-change", "v-priv-camera", "see which apps can use the camera"),
  ok("v-priv-location", "open location services"),
  ok("v-priv-tracking", "open the Tracking setting"),
  ok("v-root-accessibility", "open accessibility options"),
  ok("v-root-actionbutton", "open the Action Button settings"),
  fail("partial", "v-root-appearance", "switch the phone to dark mode"),
  ok("v-root-appearance2", "open Appearance settings"),
  ok("v-root-apps", "see the list of apps' settings"),
  ok("v-root-camera", "open Camera settings"),
  fail("no-change", "v-root-developer", "open developer settings"),
  ok("v-root-gamecenter", "open Game Center settings"),
  ok("v-root-homescreen", "open Home Screen settings"),
  fail("interrupted", "v-root-icloud", "open iCloud settings"),
  fail("wrong-screen", "v-root-passcode", "open passcode settings"),
  ok("v-root-privacy", "open privacy settings"),
  ok("v-root-privacy2", "open privacy settings"),
  ok("v-root-screentime", "open Screen Time"),
  fail("wrong-screen", "v-root-screentime", "open Passcode settings"),
  ok("v-root-search", "open search settings"),
  ok("v-root-siri", "open Siri settings"),
  fail("wrong-screen", "v-root-siri", "open Search settings"),
  ok("v-root-standby", "open StandBy settings"),
  fail("confirm", "v-safari-clear", "clear Safari's browsing history"),
  ok("v-search-close", "close the search"),
  fail("no-change", "v-search-type", "search settings for privacy"),
  ok("v-settings-general", "open General settings"),
  ok("v-signin-continue", "continue to the password step"),
  fail("alert", "v-signin-continue2", "submit the sign-in"),
  ok("v-signin-manual", "open the manual sign-in form"),
  ok("v-signin-ok", "dismiss the error"),
  ok("v-tr-add", "add a new text replacement"),
  ok("v-tr-back", "go back to keyboard settings"),
  ok("v-tr-delete", "delete the @@ shortcut"),
  ok("v-tr-done", "finish editing the list"),
  ok("v-tr-edit", "edit the list of text replacements"),
  fail("confirm", "v-tr-remove", "delete the @@ shortcut"),
  ok("v-tr-save", "save the new text replacement"),
  ok("v-tr-type-phrase", "type the email address as the phrase"),
  ok("v-tr-type-shortcut", "type @@ as the shortcut"),
  fail("wrong-screen", "v-ws-general-dictionary", "open Language & Region"),
  fail("wrong-screen", "v-ws-general-keyboard", "open the Fonts settings"),

  // Safari
  ok("v-safari-address", "focus the address bar"),
  ok("v-safari-bm-more-close", "close the menu"),
  ok("v-safari-bm-more", "open the bookmarks options menu"),
  ok("v-safari-bookmarks", "show my bookmarks"),
  ok("v-safari-cleartext", "clear what I typed"),
  ok("v-safari-continue", "dismiss the search suggestions notice"),
  fail("wrong-screen", "v-safari-dismissmenu", "close the menu"),
  ok("v-safari-history", "see the pages I visited earlier"),
  fail("wrong-screen", "v-safari-history", "show my bookmarks"),
  ok("v-safari-newtab", "open a new blank tab"),
  ok("v-safari-notnow", "skip the lock setup and keep browsing privately"),
  ok("v-safari-pagemenu", "open the page options menu"),
  fail("interrupted", "v-safari-private", "switch to private browsing"),
  ok("v-safari-readinglist", "find articles I saved to read later"),
  ok("v-safari-share-dismiss", "close the share sheet"),
  ok("v-safari-startpage", "go back to the start page"),
  ok("v-safari-tabs", "see all my open tabs"),
  ok("v-safari-type", "type weather into the search field"),

  // Maps
  ok("v-maps-allow", "let Maps use my location while I use it"),
  ok("v-maps-close", "close the map modes card"),
  ok("v-maps-continue", "get past the ads notice to the map"),
  ok("v-maps-dir-close", "close the directions"),
  ok("v-maps-directions", "get walking directions to Peet's"),
  fail("partial", "v-maps-modes", "switch the map to satellite view"),
  ok("v-maps-ok", "acknowledge the safety notice"),
  ok("v-maps-peets", "open Peet's on Market Street"),
  ok("v-maps-place-close", "close the place card"),
  ok("v-maps-satellite", "show satellite imagery"),
  ok("v-maps-search", "search for a place"),
  fail("wrong-screen", "v-maps-search", "show the map modes"),
  ok("v-maps-tipclose", "close the route options tip"),
  fail("no-change", "v-maps-traffic", "show traffic on the map"),
  ok("v-maps-transit", "take public transit instead"),
  ok("v-maps-type-coffee", "search for coffee nearby"),

  // Calendar
  ok("v-cal-add", "create a new event"),
  ok("v-cal-cal-close", "close the calendars list"),
  ok("v-cal-calendars", "open the list of calendars"),
  fail("confirm", "v-cal-cancel", "throw away this new event"),
  fail("interrupted", "v-cal-continue", "open the calendar"),
  ok("v-cal-discard", "discard the new event"),
  ok("v-cal-dontallow", "keep my location from Calendar"),
  ok("v-cal-month", "switch to the month view"),
  fail("wrong-screen", "v-cal-month", "open the Inbox"),
  ok("v-cal-notif-allow", "let Calendar send me notifications"),
  ok("v-cal-title-tap", "start typing the event name"),

  // Contacts
  ok("v-contacts-anna", "open Anna's contact card"),
  ok("v-contacts-back", "go to the list of all contacts"),
  ok("v-contacts-close", "stop editing without saving"),
  ok("v-contacts-delete-cancel", "back out of deleting the contact"),
  fail("confirm", "v-contacts-delete", "delete Anna from my contacts"),
  ok("v-contacts-edit", "edit Anna's details"),
  fail("wrong-screen", "v-contacts-edit", "call Anna"),

  // Messages
  ok("v-msg-add-close", "close the attachment menu"),
  ok("v-msg-add", "open the attachment options"),
  fail("wrong-screen", "v-msg-add", "send the message"),
  ok("v-msg-field", "start writing a message"),
  ok("v-msg-thread", "open the conversation with 555-1212"),
  ok("v-msg-type", "write On my way in the message box"),

  // Photos
  ok("v-photos-back", "go back to the photo grid"),
  ok("v-photos-collections", "browse my albums"),
  ok("v-photos-continue", "dismiss the what's new sheet"),
  ok("v-photos-delete-cancel", "keep the photo after all"),
  fail("confirm", "v-photos-delete", "delete this photo"),
  ok("v-photos-dontallow", "turn down notifications from Photos"),
  ok("v-photos-edit-cancel", "leave the editor without changes"),
  ok("v-photos-edit", "open the photo editor"),
  ok("v-photos-fav", "mark this photo as a favorite"),
  ok("v-photos-info", "see where and when this photo was taken"),
  fail("wrong-screen", "v-photos-info", "edit the photo"),
  fail("no-change", "v-photos-open-miss", "open the first photo"),
  ok("v-photos-open", "open the first photo"),

  // Files
  ok("v-files-browse", "see all my folders and drives"),
  ok("v-files-more", "open the options menu"),
  fail("wrong-screen", "v-files-more", "open the Browse tab"),
  ok("v-files-newfolder", "create a new folder here"),
  ok("v-files-recents", "show recently opened files"),

  // Reminders
  ok("v-rem-back", "see all my reminder lists"),
  ok("v-rem-delete-cancel", "keep the list"),
  fail("confirm", "v-rem-deletelist", "delete this reminders list"),
  ok("v-rem-done", "save the reminder"),
  ok("v-rem-more", "open the list's options"),
  fail("wrong-screen", "v-rem-more", "add a new reminder"),
  ok("v-rem-new", "add a new reminder"),
  ok("v-rem-notnow", "skip turning on iCloud sync"),
  ok("v-rem-openlist", "open my Reminders list"),
  ok("v-rem-type", "write the reminder text"),

  // Shortcuts
  ok("v-sc-continue", "get into the Shortcuts app"),
  ok("v-sc-gallery", "browse ready-made shortcuts"),
  ok("v-sc-library", "go to the shortcuts library"),

  // Health
  ok("v-health-browse", "browse health categories"),
  ok("v-health-continue", "start setting up Health"),
  ok("v-health-continue2", "move past the privacy notice"),
  fail("interrupted", "v-health-continue3", "finish the notification step"),
  ok("v-health-continue4", "go on to the Health summary"),
  ok("v-health-heart-back", "go back to the categories"),
  ok("v-health-heart", "open the Heart category"),
  fail("wrong-screen", "v-health-heart", "open the Sleep category"),
  ok("v-health-next", "skip the health details for now"),
  ok("v-health-ok", "accept that notifications stay off"),
  ok("v-health-sharing", "open the Sharing tab"),

  // Wallet
  fail("alert", "v-wallet-add", "add a card to Wallet"),
  ok("v-wallet-more-close", "close the menu"),
  ok("v-wallet-more", "open Wallet's options"),
  ok("v-wallet-ok", "dismiss the error"),
  ok("v-wallet-orders-done", "close the orders list"),
  ok("v-wallet-orders", "open my orders"),
  fail("wrong-screen", "v-wallet-orders", "add a card"),

  // Passwords
  ok("v-pw-allow", "allow Passwords notifications"),
  ok("v-pw-cancel", "abandon the new password"),
  ok("v-pw-continue", "get past the welcome screen"),
  ok("v-pw-continue2", "move past the notifications explanation"),
  ok("v-pw-new", "open the new password form"),
  ok("v-pw-wifi-back", "go back to the password categories"),
  ok("v-pw-wifi", "see saved Wi-Fi passwords"),
  fail("wrong-screen", "v-pw-wifi", "see my passkeys"),

  // News
  ok("v-news-audio", "open the Audio tab"),
  ok("v-news-continue", "get into Apple News"),
  ok("v-news-puzzles", "open the puzzles section"),
  fail("wrong-screen", "v-news-puzzles", "show sports news"),

  // Fitness
  fail("interrupted", "v-fit-continue", "see the workout types"),
  ok("v-fit-dontallow", "no notifications from Fitness"),
  ok("v-fit-ok", "finish the Workout Buddy intro"),
  ok("v-fit-workout", "open the Workout tab"),
  fail("interrupted", "v-fit-workout", "start an outdoor run"),

  // Watch, Remote
  ok("v-watch-dontallow", "block notifications from the Watch app"),
  ok("v-watch-faces", "browse watch faces"),
  fail("no-change", "v-remote-choose", "pick which TV to control"),
];

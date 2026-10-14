# Passwords: threat model

Realm 2.3 fills passwords in its browser panes for the person (a menu under the field) and for
agents (`browser_credentials`, `browser_fill_credential`), from three sources: passwords saved in
Realm, a CSV export imported from the Passwords app or another manager, and the internet passwords
in the macOS login keychain. This page says what each part defends against and what it does not.

## What is protected

The plaintext of a password. It exists in three places only: sealed in `secrets.json` (AES-256
under a keyring that `safeStorage` keeps in the login Keychain), in the login keychain itself, and
for a moment in Electron main while it is typed into a page, put on the clipboard, or drawn in a
native sheet. It is never sent to realm-server, a renderer, an agent, a transcript, a tool result or
a log line. `BrowserCredential`, the only shape any of those ever sees, has no field for a value.

## Who we defend against

| Actor | Can | Cannot |
| --- | --- | --- |
| A web page in a pane | Be clicked on; read what is typed into its own fields | Call Realm's binding or read its fields map (both live in an isolated world); synthesize the trusted click that opens the menu; script, cover or restyle the menu (it is an NSMenu); see the Save bar (Realm's renderer) |
| A lookalike or downgraded site | Ask to be filled | Get a password: matching is by origin and registrable domain under the public-suffix list, never across schemes downward (an `https` password is not offered on `http`) |
| A cross-origin or same-origin iframe | Host a login form | Get a menu or a fill: Realm's script returns at once in any frame, and main checks every report came from the top frame's isolated world at the pane's committed origin |
| An agent (model) | List metadata; ask for a fill on a card; ask Realm to generate one | Receive a value; fill without the person's card or standing allow; skip the unlock (Touch ID by default); enroll, import, edit, reveal or copy; answer the Save bar or Settings (`data-no-agent`); fill on a page other than the one the card named |
| Anything with a shell as the user | Read `secrets.json` ciphertext; edit it | Open it without the Keychain item; forge an "Always allow" (sealed with profile, password, origin and this Mac's id) |

## The gates, in order

**Person's menu fill.** Trusted click on an empty sign-in field, or ↓ → main checks the report's
execution context (Realm's world, top frame, committed origin) → list matches → NSMenu → on a pick,
re-read the page origin from CDP and require a site match → type the username (no unlock: it is not
a secret) → unlock by the profile's policy (Touch ID by default; a successful check covers the
person's next picks for one minute, and never an agent's) → type the password.

**Agent fill.** Card (always shown, even under bypass, unless the person answered "Always allow on
this site" for this password on this exact origin) → main checks the live page is exactly the
origin the card named and the password is of its site → unlock by policy → type. Generated passwords
and team roles keep the card on every fill.

**Save.** The isolated-world script reads a sign-in form when it is sent within five seconds of the
person's own input, and hands username and password to main, which holds them in memory. Nothing is
offered until the sign-in looks finished (top frame navigated, or the password field went away), and
not at all if the profile already holds that password or the site is on the never list. The bar
names site and username only; Save seals the value in main. Unanswered offers are forgotten after
five minutes or when the pane closes.

**Show and Copy (Settings).** Always ask macOS (Touch ID or the login password), whatever the unlock
policy. Show draws the password in a native sheet from main; Copy writes the clipboard from main and
clears it after 30 seconds if it is still the same value (only a digest is kept for that check).

**Import.** Main opens the file through the system's open panel, parses it, seals each row, counts
what happened, and offers to move the file to the Trash. Errors name line shapes, never contents.

**Login keychain.** Off until the person turns it on. Listing reads attributes only (no prompt).
A value is read one item at a time, at fill, Show or Copy, after Realm's own unlock and then macOS's
own prompt unless the item already trusts the helper. Realm keeps no copy. A live check or test can
point Realm only at a scratch keychain (`REALM_LIVE_KEYCHAIN`, honoured only in an unpackaged harness
build); without it a harness has no keychain at all.

## Known limits

- **Apple's sources.** Other apps cannot read the Passwords app or iCloud Keychain. Those come in
  as an export the person makes. Shared-credential groups and Apple's associated-domain quirks are
  not modelled.
- **The page sees what it is given.** A filled password is in the page's DOM, as in any browser. A
  same-site page compromised by XSS can read it; the menu limits this to the site's own passwords
  and the unlock to moments the person chose.
- **A shell can answer cards.** Anything that can read `daemon.json` can call
  `sessions.respondPermission`. This predates passwords; the unlock (Touch ID) is the gate a shell
  cannot pass, unless the profile is set to "Without asking".
- **Clipboard.** Clipboard managers may record a copied password before Realm clears it.
- **Off macOS.** No Touch ID or keychain. Saved and imported passwords still work: the person's own
  menu pick or Settings press stands in for the presence check, and agent fills there are refused.
- **Save heuristics.** A form that fails to sign in but navigates anyway can be offered for saving.

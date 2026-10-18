import { careful, h2, h3, note, p, page, steps, table, tip, ul } from "@/lib/docs-blocks"

export default page({
  slug: "browser",
  title: "The browser",
  summary:
    "Realm has a browser built into the side panel, signed in per profile, with a password manager your agents can use without ever seeing a password.",
  body: [
    h2("Open a page"),
    ul(
      "In the side panel, **+ ▸ New tab** or [[⌘⇧B]]. [[⌘⌥B]] opens one in full view, across the whole window.",
      "**File ▸ New Browser**, or **New browser** in the palette.",
      "Right-click any link in Realm and choose **Open in Realm Browser**.",
    ),
    p(
      "A new tab has an address bar over Realm's tools and the pages you visited recently. Type an address or a search and press [[↩]].",
    ),
    p(
      "Where links open is **Settings ▸ General ▸ Open links in**: your **Default browser** (the default) or **Realm Browser**. [[⌘]]-click a link to open it in the other one.",
    ),

    h2("The browser's bar"),
    table(
      ["Control", "What it does"],
      ["Back and forward", "Right-click either for the pages behind or ahead"],
      ["Reload / Stop", "Reloads the page, or stops it loading"],
      ["**Pick an element**", "Click a part of the page to send it to the prompter, so your next message can point at it"],
      ["**Annotate**", "Pin several elements on the page, then send them to the prompter together"],
      ["**More**", "Find in page, print, zoom, take a screenshot, downloads, history, device size, and the profile's browser settings"],
    ),
    p(
      "**More ▸ Device size** draws the page at a phone's width (**iPhone · 390px**), a tablet's (**iPad · 820px**) or a desktop's (**Desktop · 1440px**), or back to **Fit the pane**. A screenshot is saved into the space's folder.",
    ),

    h2("Profiles keep their own sign-ins"),
    p(
      "Each [profile](/docs/spaces-and-worktrees#profiles) has its own browser: its own cookies and site data, its own saved passwords and passkeys. Signing in to a site in a Work profile's pane doesn't sign you in to it in Personal. Every pane in one profile shares the same sign-ins.",
    ),
    ul(
      "**More ▸ Share this site's sign-in with** copies one site's sign-in to another profile.",
      "**More ▸ Clear browsing data…** signs this profile's panes out of every site.",
    ),

    h2("Saved passwords"),
    p(
      "**Settings ▸ Passwords** holds the profile's saved passwords and passkeys. Only that profile's agents and browser panes can use them, and the values are encrypted with a key macOS keeps in your login keychain.",
    ),
    h3("Get your passwords in"),
    ul(
      "**Add a password** takes a site address, a username, a label and the password.",
      "**Import…** reads an export from the Passwords app (in Passwords, **File ▸ Export All Passwords**), Chrome, 1Password or Bitwarden. Apple doesn't let other apps read the Passwords app directly. Realm encrypts what it imports and offers to move the file, which holds every password in plain text, to the Trash.",
      "**Use passwords from the login keychain** also offers the internet passwords in your login keychain. macOS asks you before Realm reads one, and Realm keeps no copy.",
      "When you sign in to a site in a pane, Realm offers to **Save** the password (or **Update** it), with **Not now** and **Never for this site**.",
    ),
    h3("Fill a password"),
    p(
      "Click an empty sign-in field in a pane and Realm lists the site's saved passwords; pick one, confirm it's you, and Realm fills it. **Manage passwords…** at the foot of that list opens Settings.",
    ),
    p(
      "In Settings, each password's menu can show it, copy it, or edit it. macOS asks for you first, and a copied password is cleared from the clipboard after 30 seconds. **Share with** copies a password into another profile.",
    ),
    h3("Unlocking"),
    p("Under **Security**, choose what a fill needs from you:"),
    table(
      ["Unlock with", "Meaning"],
      ["**Touch ID**", "Touch ID for each fill, or once for a short window you set under it"],
      ["**Touch ID or password**", "Touch ID, or this Mac's login password when there's no sensor or nobody at it"],
      ["**Once per session**", "One Touch ID or password check unlocks the profile's passwords for a number of hours"],
      ["**Without asking**", "Agents fill without asking anyone, for a Mac left running on its own. Every fill is still logged, and a sheet says what this costs before it turns on."],
    ),

    h2("Agents and your passwords"),
    p(
      "An agent driving a browser pane can sign you in without ever receiving the password. It asks Realm to fill a saved one, and Realm types it into the page itself. The value never reaches the model or the transcript.",
    ),
    steps(
      "The agent asks to fill a saved password on the page it's on.",
      "A card shows you the site, the username and the label. Choose **Allow**, or **Always allow on this site** to skip the card there next time.",
      "Touch ID, or however your profile unlocks, confirms you're there, and Realm fills the form.",
    ),
    ul(
      "The page has to be on exactly the site the password was saved for, checked again just before typing: no subdomains, no lookalikes.",
      "The card shows in every permission mode, Full access included.",
      "For a sign-up, an agent can have Realm make a new random password, save it and fill it under the same checks. It shows as **Generated by Realm** in Settings. Nobody can read it back, so the site's own reset is how you get in elsewhere.",
      "Every fill is logged, without the value, in `~/Realm/logs/credential-audit.log`.",
    ),
    careful(
      "Agents can't type into a password field in any mode, and Realm doesn't automate two-factor codes or push approvals. A sign-in with two-factor stops after the password, and you finish it in the pane.",
    ),

    h2("What agents can do in a page"),
    p(
      "With Realm's browser tools, an agent can open and navigate pages, read them (the page's structure and text, its console and network log), click, type, scroll and press keys, upload a file, download one, and take screenshots. While one is driving, the pane says **Agent is driving**. Reading a page never asks; acting on one follows the session's [permission mode](/docs/permissions).",
    ),
    p(
      "A download only goes through as part of an action you've allowed; anything else a page tries to download is stopped, and the pane offers you a button to save it. An agent's downloads land in `downloads/` in the space's folder.",
    ),
    tip(
      "To hand a whole errand on the web to an agent, ask your session to use a browser agent: a sub-agent that only browses. See [Sub-agents](/docs/sub-agents#the-browser-agent).",
    ),
    note("The browser is Chromium, inside Realm. Your own browser's cookies, history and extensions aren't in it."),
  ],
})

# The lab: a Mac that runs a team's work on its own

A lab is a Mac (a Mac mini, usually) set aside to run a team's roles around the clock, with
iPhones on its cables for the apps that only run on a real phone. Everything about it is in
**Settings ▸ Lab** on that Mac.

## Get the Mac ready

Settings ▸ Lab ▸ *Ready to be left alone* reads the Mac and says what is missing. Realm only
reads: a fix that needs an administrator is shown as the command to run yourself.

| Check | What Realm reads | The fix |
| --- | --- | --- |
| Never sleeps | `pmset -g` | `sudo pmset -a sleep 0 disksleep 0`. Until then, the row's switch keeps the Mac awake while agents work. |
| Starts after a power failure | `pmset -g` (`autorestart`; desktops only) | `sudo pmset -a autorestart 1` |
| Comes back to the desktop after a restart | `fdesetup status` | With FileVault on, a restart stops at the unlock screen and macOS will not log in by itself. Turn it off in Privacy & Security for a lab that must come back alone. |
| Logs in by itself | `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser` | Users & Groups ▸ Automatically log in as (after FileVault is off). |
| Has a display | `system_profiler SPDisplaysDataType` | An HDMI dummy plug on a headless Mac. Window capture needs a display. |
| At least 50 GB free | the disk holding Realm's home | Free space. A full disk can hang a Mac that is swapping. |
| Online | the default route, and whether `github.com` resolves | A cable is steadier than Wi-Fi. |
| Rides out a power cut | `pmset -g ps` | A UPS. Runs a restart stopped start again on their own. |
| Reachable from your laptop | whether Screen Sharing is listening | General ▸ Sharing ▸ Screen Sharing. |
| Sign-ins can be unlocked | the profile's unlock setting and the Touch ID sensor | A Magic Keyboard with Touch ID, or another unlock in Settings ▸ Sign-ins. |
| Realm opens at login | Realm's login item | The row's switch (the installed app only). |

Then turn on **This Mac is a lab**.

## Updates

Installing Realm stops every session it hosts, so on a lab an update does not ask before it
restarts. It waits for the update window (4:00 AM unless you change it), stops new team runs,
waits for running ones (30 minutes unless you change it), installs, and starts the held runs
again once the new version is up. A run still going at the cap is stopped by the restart and
queued again without spending its attempts. The line under *Update window* says which step it is
on; *Update now* opens the window early.

## Devices

*Look for devices* lists the iPhones on the cables and the simulators that are running. Add the
ones the lab uses, give each to a team, and name the accounts it holds (at most three a phone,
each one consented to). Passwords never go here; they belong in the team's vault. A device's
*Last seen* is when a look last found it on the cable.

## Reach the lab from your laptop

In Realm on your laptop, open a **Machine** (the side panel's +, or the palette), choose
**Another Mac**, and enter the lab's address, shown under Settings ▸ Lab ▸ *Reach this Mac*
(`<name>.local`). Screen Sharing has to be on at the lab. Its password is sealed in the laptop's
Keychain like every machine password.

Answering Needs you and Review from your phone comes later, with Realm's mobile app (Plan 28).

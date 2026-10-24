import { code, h2, h3, note, p, page, table, tip, ul } from "@/lib/docs-blocks"

// Read from feat/remote-runtime (local, in realm-worktrees/oct24-remote-runtime: README "A server on another
// machine", apps/server/src/ctl/, access/ and remote/home-key.ts) and the packaged paths from #222
// (feat/packaged-cli). The Mac caveat about a shared home is the builder's; the rest is in that source.
export default page({
  slug: "run-on-a-server",
  title: "Run Realm on a server",
  summary:
    "Keep Realm's agent server running on another machine, a Linux box or a Mac that stays on, drive it from your laptop with the realm command, and pair your phone with it.",
  body: [
    note("Running Realm on a server is new in Realm 2.5, with the [command line](/docs/command-line)."),
    p(
      "`realm serve` runs Realm's agent server without a window. Run it on a machine that stays on and your agents keep working with your laptop closed: from the laptop you drive it with `realm --server`, and your phone pairs with it as it would with a Mac. Realm's window doesn't connect to a server on another machine; the command line and the phone are the ways in.",
    ),

    h2("What you need"),
    ul(
      "A machine that stays on, with Linux or macOS, and git.",
      "The agent CLIs you'll run, installed and signed in on the server. Sign each one in once, over SSH, with its own sign-in command, such as `claude auth login` (see [Getting started](/docs/getting-started#sign-in-to-more-agents)).",
      "A way for your laptop to reach it: Tailscale, an SSH login, or a TLS certificate for an open port. [Choose how to reach it](/docs/run-on-a-server#choose-how-to-reach-it) compares them.",
      "`realm` on your laptop as well. See [Command line](/docs/command-line#install).",
    ),

    h2("Install it on the server"),
    p(
      "Every packaged Realm carries the `realm` command and runs it on the app's own runtime, so the server needs no Node.js and no display. On a Linux server, download the AppImage from the [latest release](https://github.com/31Carlton7/realm/releases/latest), extract it, and link its `realm` into a folder on your `PATH`:",
    ),
    code(
      `chmod +x Realm-*.AppImage
./Realm-*.AppImage --appimage-extract
ln -s "$PWD/squashfs-root/resources/bin/realm" ~/.local/bin/realm`,
      "Terminal, on the server",
    ),
    p(
      "From the .deb, the command is `/opt/Realm/resources/bin/realm`; the deb's own `/usr/bin/realm` opens the window. On a Mac it's inside Realm.app. [Command line](/docs/command-line#install) lists every place, and how to build it from source instead.",
    ),

    h2("Make an access token"),
    p("A client on another machine needs an access token, made on the server:"),
    code(
      `$ realm token create laptop
rlm_9fKx2N0pLmQ4vR7sTzW1yB3cD5eF8gH6jA0kXo2uIq4

That is the only time this token is shown. On the client:
  realm remote add <name> <url>   (paste it when asked)
or set REALM_TOKEN. Revoke it with: realm token revoke laptop`,
      "Terminal, on the server",
    ),
    ul(
      "Only a hash of each token is kept, in the home's `access-tokens.json`, so a copy of the home, such as a backup, holds nothing that opens the server.",
      "Tokens are made on the server itself, by someone who can read its home. Nothing makes one over the network, so a stolen token can't make itself a successor.",
      "`realm token list` shows each token's id and name and when it was made, never the token. `realm token revoke laptop` revokes one, and a client using it is disconnected within seconds.",
      "Make one per device, named for it, so you can revoke one without the others.",
    ),

    h2("Choose how to reach it"),
    p("The server listens only on its own loopback address until `realm serve` is told otherwise. There are three ways in, from the one to prefer to the one to use last."),
    h3("Tailscale Serve"),
    code("realm serve --tailscale", "Terminal, on the server"),
    p(
      "Realm listens on `127.0.0.1:7420` and runs `tailscale serve --bg --https=443 http://127.0.0.1:7420`, so only devices on your tailnet can reach it, over HTTPS with the machine's own certificate. It prints the address to give your laptop, such as `wss://vps.tail1234.ts.net`, and takes Serve down again when it stops. `--tailscale-port` picks an HTTPS port other than 443. It uses Serve, never Funnel, so nothing is put on the public internet.",
    ),
    p(
      "The machine has to be signed in to Tailscale, with MagicDNS and HTTPS certificates turned on for the tailnet; `realm serve` checks before it starts. On Linux, Tailscale may let only root change Serve: if it says access was denied, run `sudo tailscale set --operator=$USER` once.",
    ),
    h3("An SSH tunnel"),
    code(
      `# on the server
realm serve --listen 127.0.0.1:7420

# on your laptop
ssh -N -L 7420:127.0.0.1:7420 you@server
realm remote add server ws://127.0.0.1:7420`,
      "Terminal",
    ),
    p("The token travels inside SSH, and nothing listens beyond the server's loopback address. The tunnel has to be open while you use the server."),
    h3("TLS on an open port"),
    code("realm serve --listen 0.0.0.0:7420 --tls-cert cert.pem --tls-key key.pem", "Terminal, on the server"),
    p(
      "Every address of the machine, over `wss://`. A renewed certificate, from certbot or `tailscale cert`, is picked up within ten minutes without a restart. For a self-signed certificate, give your laptop the certificate to trust, with `--ca cert.pem`.",
    ),
    h3("What it refuses"),
    ul(
      "Listening on every address (`0.0.0.0`, `::`) or on a public one without TLS. No flag allows it.",
      "Listening on a private address, such as a LAN's or a tailnet's, without TLS, unless `--allow-plaintext` says the network encrypts on its own, as a tailnet or WireGuard does.",
      "On your laptop, sending a token over `ws://` to anything but your own machine, unless you pass `--allow-plaintext`.",
      "A connection without a valid access token. The server's own token, in `daemon.json`, doesn't open it.",
      "A connection from a web page, even with a token.",
      "An address refused ten times in a minute, which is refused for the minute after, valid token or not. Behind Tailscale Serve or an SSH tunnel every client arrives from the server itself, so they share that count.",
    ),

    h2("Drive it from your laptop"),
    p("Save the server under a name. Realm asks for the token without showing what you type, and connects with it before it saves anything:"),
    code(
      `$ realm remote add vps wss://vps.tail1234.ts.net
Access token (from realm token create on the server):`,
      "Terminal, on your laptop",
    ),
    p("Then give any command `--server`. Paths are the server's, so they're absolute:"),
    code(
      `realm --server vps repo add /home/you/code/shop
realm --server vps run /home/you/code/shop --worktree login-bug -- \\
  claude -p "Fix the login redirect loop" --permission-mode acceptEdits
realm --server vps wait --timeout 3600`,
      "Terminal, on your laptop",
    ),
    table(
      ["Option", "What it does"],
      ["`--server NAME` or `--server URL`", "The server to use: a saved remote, or a `ws://` or `wss://` URL. Also `$REALM_SERVER`."],
      ["`--token T`", "The access token, with a URL. Also `$REALM_TOKEN`. A saved remote carries its own."],
      ["`--ca FILE`", "A certificate to trust, for a server with a self-signed one. Also `$REALM_CA`."],
      ["`--allow-plaintext`", "Sends the token over `ws://` to another machine, on a network that encrypts on its own."],
    ),
    ul(
      "Saved remotes are in `~/.config/realm/remotes.json`, which only your account can read; Realm refuses to use the file if other users can. `realm remote list` shows them, and `realm remote remove vps` forgets one.",
      "`realm token`, `realm serve` and `realm service install` act on the machine you run them on, and refuse `--server`.",
    ),

    h2("Keep it running as a service"),
    code("realm service install --tailscale", "Terminal, on the server"),
    p("`realm service install` takes the same options as `realm serve`, and runs it in the background:"),
    ul(
      "On Linux it writes a systemd user unit, `~/.config/systemd/user/realm.service`, starts it, and restarts it if it fails. A user's services stop at logout unless the user lingers, so run `loginctl enable-linger $USER` to keep it running and start it at boot; `realm` says so when it's needed. Its output is in `journalctl --user -u realm`.",
      "On a Mac it writes a launchd agent, `~/Library/LaunchAgents/co.charmtechnologies.realm.server.plist`, which starts when you log in and writes to `logs/service.log` in the home.",
      "`realm service status` says whether it's running, and exits with 1 when it isn't. `realm service uninstall` stops it and removes the file.",
      "The file runs the exact Realm you installed it from, with the `PATH` you had, so it finds the agent CLIs your shell finds. Move Realm or update your `PATH` and install again.",
      "Windows has no `realm service`: keep `realm serve` running with a supervisor of your own.",
    ),

    h2("Pair a phone with realm pair"),
    p(
      "`realm pair` draws the pairing code in the terminal, as **Settings ▸ Devices ▸ Pair an iPhone** does on a Mac, with its link under it. Scan it with Realm on your iPhone, or copy the link and choose **Paste the link**. When the phone answers, the terminal asks:",
    ),
    code(`Pair "Ada's iPhone" (iPhone 17 Pro)? It can read every session on vps and answer for you. [y/N]`, "Terminal"),
    ul(
      "Run it on the server, or from your laptop with `realm --server vps pair`: the code is drawn, and the yes typed, in whichever terminal you're in.",
      "The code works once, for five minutes. [[⌃C]] stops waiting, and the code stops working.",
      "`realm phones` lists the phones paired with the server, and `realm phones remove <id|name>` takes one back, so it can no longer reach the server.",
      "A paired phone shows the server's spaces and sessions, and gets its notifications, as with a Mac (see [Mobile](/docs/mobile)). It doesn't show terminals, so what you start with `realm run` is followed with `realm ps` and `realm logs`.",
    ),
    p(
      "On a Mac, the key that seals the phones' pairing is kept in the Keychain. A server with no Realm window has nobody to unlock that, so it keeps a key of its own, in `keys/remote.key` in its home, which only its user can read. Set `REALM_REMOTE_KEY_FILE` to keep it somewhere else, such as a systemd credential, and Realm reads it there and never writes it. Anyone who can read the server's home can read the key.",
    ),
    p(
      "Phones paired through Realm's window on a Mac stay paired: a server started with `realm serve` on that home never replaces them, and if it needs their key, it asks you to open Realm on that Mac once.",
    ),

    h2("Security"),
    ul(
      "A token can do anything you can do in Realm on that machine, and that includes running commands as the server's user. Treat it like an SSH key.",
      "It can't act as Realm's own window, which drives the browser panes, or say someone is sitting at the machine.",
      "After a leak, revoke the token, then check `realm phones`: a token can pair a phone, and a paired phone stays paired until you remove it.",
      "The tokens' hashes, the pairing key and `daemon.json` can be read only by the server's user, and anyone who can log in as that user can drive the server without a token.",
      "The agents run as the server's user, with its files and its network. A space's [sandbox](/docs/permissions#the-sandbox) is a Mac's alone.",
      "Keep tokens out of shell history: `realm remote add` asks for one rather than taking it on the command line, and a saved remote keeps it in a file only you can read.",
    ),

    h2("A worked example"),
    p(
      "An Ubuntu server on your tailnet runs your agents; your laptop starts their work and reads what they did; your phone pairs with it. First, over SSH, on the server:",
    ),
    code(
      `# Realm, from the AppImage on the release page
chmod +x Realm-*.AppImage
./Realm-*.AppImage --appimage-extract
ln -s "$PWD/squashfs-root/resources/bin/realm" ~/.local/bin/realm

# the code, and the agent CLI the tasks run, signed in once
git clone git@github.com:you/shop.git ~/code/shop
claude auth login

# a token for the laptop, then the server as a service, behind Tailscale Serve
realm token create laptop
realm service install --tailscale
loginctl enable-linger $USER`,
      "Terminal, on the server",
    ),
    p(
      "The server's address is its name on your tailnet, such as `wss://vps.tail1234.ts.net`, which it prints as it starts: `journalctl --user -u realm` shows it. Then, on your laptop, save it with the token and give it work:",
    ),
    code(
      `realm remote add vps wss://vps.tail1234.ts.net
realm --server vps run /home/you/code/shop --worktree login-bug -- \\
  claude -p "Fix the login redirect loop" --permission-mode acceptEdits
realm --server vps run /home/you/code/shop --worktree search-api -- \\
  claude -p "Add paging to /api/search" --permission-mode acceptEdits
realm --server vps wait --timeout 3600
realm --server vps logs 01M5P8GCQE5X44PTAZ7A7R5RDC`,
      "Terminal, on your laptop",
    ),
    p(
      "Close the laptop and the work goes on. Each task's changes are on its own branch in a worktree on the server, to review and merge there with git. Last, pair your phone, from the laptop or the server:",
    ),
    code("realm --server vps pair", "Terminal, on your laptop"),
    tip("[Command line](/docs/command-line#a-worked-example) has a fuller example of six tasks at once, and every command's output."),

    h2("On a Mac"),
    p(
      "A Mac left on works as a server too, and `realm service install` makes it a launchd agent. Give it a home of its own, with `--home ~/realm-server`, rather than the one Realm's window uses. On the window's home, an update of Realm restarts the server without your `--listen`, and your laptop loses it.",
    ),

    h2("Limits"),
    ul(
      "Realm's window on your laptop doesn't connect to a server elsewhere: you drive it with `realm`, and follow its sessions on your phone.",
      "`realm run` starts commands, not Realm sessions, so what it starts shows in `realm ps` rather than on your phone.",
      "On Linux there's no sandbox, computer use, simulators or Laya, as in the [Linux preview](/docs/troubleshooting#linux-and-windows).",
      "Realm for iPhone is in TestFlight, and isn't open to the public yet.",
      "It's new. Serving clients on other machines and pairing a phone have been tried on Debian, in a container, and the packaged server has run headless on GitHub's Ubuntu runners.",
    ),
  ],
})

// post-key: press one key at the session level, as a keyboard would, for the quick chat panel's
// live check (../quick-chat-panel-live.mjs). One JSON line.
//
//   post-key <keyCode> [command] [control] [option] [shift] [session]
//
// Posted where a keyboard's events enter, so the system's own hot keys see it; `session` posts it
// one stage later, past them.
//
// The check presses F19, which does nothing in an app that receives it by mistake, alone to see which
// page has the keyboard and with all four modifiers as the panel's chord. It asks for no permission:
// without the grant to post events it prints that and exits 3.
// Build: swiftc -O -o post-key post-key.swift
import CoreGraphics
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard let first = args.first, let code = UInt16(first) else { print("usage: post-key <keyCode> [command] [control] [option] [shift]"); exit(1) }
guard CGPreflightPostEventAccess() else { print("{\"error\":\"posting events is not granted: nothing was pressed\"}"); exit(3) }
let names: [String: CGEventFlags] = ["command": .maskCommand, "control": .maskControl, "option": .maskAlternate, "shift": .maskShift]
var flags: CGEventFlags = []
for name in args.dropFirst() { if let flag = names[name] { flags.insert(flag) } }
let source = CGEventSource(stateID: .privateState)
for down in [true, false] {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { print("{\"error\":\"no event\"}"); exit(2) }
  event.flags = flags
  event.post(tap: args.contains("session") ? .cgSessionEventTap : .cghidEventTap)
  usleep(30_000)
}
print("{\"pressed\":\(code)}")

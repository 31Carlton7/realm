// meeting-standin: stands in for a calling app or a browser in a call, for meeting-watch-live.mjs.
// Nothing of it can be seen or heard.
//
//   meeting-standin [--title <window title>] <hold seconds> [<gap seconds> <hold seconds> …]
//
// Holds the default input for each hold (samples thrown away, nothing played), letting go between.
// With --title it also owns a window of that title: alpha 0, behind everything, ignoring the mouse,
// never key, in an app with no Dock icon that is never activated. The check runs it from a bundle,
// so Core Audio and the window server know it by a bundle id.
// Needs Microphone already granted to the responsible app: checked, never asked for.

import AppKit
import AVFoundation
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)
guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { print("Microphone is not granted: input not opened"); exit(3) }

func defaultInput() -> AudioObjectID {
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var device = AudioObjectID(0)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &device)
  return device
}

let began = Date()
func say(_ s: String) { print(String(format: "standin t=%.2f %@", Date().timeIntervalSince(began), s)) }

func hold(_ seconds: Double) {
  let device = defaultInput()
  var proc: AudioDeviceIOProcID?
  let made = AudioDeviceCreateIOProcIDWithBlock(&proc, device, DispatchQueue(label: "standin")) { _, _, _, _, _ in }
  guard made == noErr, let proc else { say("could not make an IO proc: \(made)"); exit(2) }
  say("input open (\(AudioDeviceStart(device, proc)))")
  usleep(useconds_t(seconds * 1_000_000))
  AudioDeviceStop(device, proc)
  AudioDeviceDestroyIOProcID(device, proc)
  say("input closed")
}

var arguments = Array(CommandLine.arguments.dropFirst())
var title: String?
if arguments.first == "--title" { title = arguments[1]; arguments.removeFirst(2) }
let schedule = arguments.compactMap(Double.init)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var window: NSWindow?
if let title {
  let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 120), styleMask: [.borderless], backing: .buffered, defer: false)
  w.title = title
  w.alphaValue = 0
  w.hasShadow = false
  w.ignoresMouseEvents = true
  w.orderBack(nil)
  window = w
  say("window up, alpha 0")
}

Thread.detachNewThread {
  _ = defaultInput()
  say("known to Core Audio as \(Bundle.main.bundleIdentifier ?? "(no bundle id)")")
  usleep(1_500_000)
  for (i, seconds) in schedule.enumerated() {
    if i % 2 == 0 { hold(seconds) } else { usleep(useconds_t(seconds * 1_000_000)) }
  }
  usleep(500_000)
  exit(0)
}
app.run()

// Realm's device-owner check: LocalAuthentication's `.deviceOwnerAuthentication`, which is Touch ID
// where there is a sensor and a finger, and the Mac's login password otherwise. Electron's own
// `systemPreferences.promptTouchID` is biometrics only, so a Mac mini with an ordinary keyboard — or
// one reached over Screen Sharing — could never say yes to it.
//
//   deviceowner can            prints "yes" or "no"
//   deviceowner ask <reason>   exits 0 when macOS confirmed the owner, 1 when it did not
//
// It answers yes or no and nothing else: no password passes through here, and none is seen by Realm.
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
guard args.count >= 2 else { exit(2) }

let context = LAContext()
var error: NSError?
let can = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)

switch args[1] {
case "can":
  print(can ? "yes" : "no")
  exit(0)
case "ask":
  guard can, args.count >= 3 else { exit(1) }
  let done = DispatchSemaphore(value: 0)
  var confirmed = false
  context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args[2]) { success, _ in
    confirmed = success
    done.signal()
  }
  done.wait()
  exit(confirmed ? 0 : 1)
default:
  exit(2)
}

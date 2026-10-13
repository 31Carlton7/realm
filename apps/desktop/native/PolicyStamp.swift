// Realm's unlock-policy stamp: one number per profile, kept in the login Keychain rather than in
// secrets.json, that a sealed unlock policy has to match to be honoured. The file can be saved and put
// back by anything with a shell; the Keychain item cannot be put back with it, so a policy restored
// from an older copy of the file carries an older number and reads as Touch ID.
//
//   policystamp read <service> <account>     prints the number; exit 3 when there is none, 4 when the
//                                            item is not one this program can read without asking
//   policystamp bump <service> <account>     moves the number on by one and prints it; exit 1 if it
//                                            could not
//   policystamp forget <service> <account>   removes it — only under a "Realm Test " service, so a
//                                            test can clean up after itself and nothing else can
//
// There is no way to SET a number. The first one is random, and every later one is the last plus
// one, so running this program cannot take the stamp back to a value a saved file was sealed with —
// and an item removed and made again starts somewhere new. Nothing here ever raises a prompt: a
// read or a change macOS would have to ask about fails instead.
import Foundation
import Security

let args = CommandLine.arguments
guard args.count >= 4 else { exit(2) }
let command = args[1], service = args[2], account = args[3]

let item: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]
let quiet: [String: Any] = [kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
func with(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] { a.merging(b) { _, new in new } }

enum Stamp { case none, unreadable, value(UInt64) }

func current() -> Stamp {
  var out: CFTypeRef?
  let status = SecItemCopyMatching(with(with(item, quiet), [
    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
  ]) as CFDictionary, &out)
  if status == errSecItemNotFound { return .none }
  guard status == errSecSuccess, let data = out as? Data, let text = String(data: data, encoding: .utf8),
        let n = UInt64(text) else { return .unreadable }
  return .value(n)
}

func store(_ n: UInt64, replacing: Bool) -> Bool {
  let data = Data(String(n).utf8)
  if replacing {
    return SecItemUpdate(with(item, quiet) as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess
  }
  return SecItemAdd(with(item, [
    kSecValueData as String: data,
    kSecAttrLabel as String: "Realm unlock policy",
    kSecAttrDescription as String: "Which saved Without-asking setting is current. Removing it puts sign-ins back on Touch ID.",
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
  ]) as CFDictionary, nil) == errSecSuccess
}

/// A fresh start: high enough that it is no one's guess, low enough that every value stays a number
/// JavaScript holds exactly (under 2^53, with room to count up).
func fresh() -> UInt64 { UInt64.random(in: (1 << 40)..<(1 << 52)) }

switch command {
case "read":
  switch current() {
  case .none: exit(3)
  case .unreadable: exit(4)
  case .value(let n): print(n); exit(0)
  }
case "bump":
  var next: UInt64
  switch current() {
  case .value(let n):
    next = n + 1
    guard store(next, replacing: true) else { exit(1) }
  case .none:
    next = fresh()
    guard store(next, replacing: false) else { exit(1) }
  case .unreadable:
    // Made by something else: it cannot be read here, so it is replaced — if macOS lets that happen
    // without asking. If it does not, nothing can be stamped and the caller keeps the default.
    let gone = SecItemDelete(with(item, quiet) as CFDictionary)
    guard gone == errSecSuccess || gone == errSecItemNotFound else { exit(1) }
    next = fresh()
    guard store(next, replacing: false) else { exit(1) }
  }
  print(next)
  exit(0)
case "forget":
  guard service.hasPrefix("Realm Test ") else { exit(2) }
  let gone = SecItemDelete(with(item, quiet) as CFDictionary)
  exit(gone == errSecSuccess || gone == errSecItemNotFound ? 0 : 1)
default:
  exit(2)
}

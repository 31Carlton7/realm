// The login keychain's internet passwords, for Realm's password menu and its agents' fills.
//
//   realmkeychain list [--keychain <path>]
//       One JSON object per line for each http(s) internet password: server, account, protocol, port,
//       path, label, modified. Attributes only — never a password — so listing raises no prompt, and
//       with no UI allowed a locked keychain lists nothing (exit 4) rather than asking to be unlocked.
//
//   realmkeychain read --server <s> --account <a> --protocol https|http --port <n> --path <p> [--keychain <path>]
//       That one item's password on stdout, with no newline. macOS asks the person first unless the
//       item already trusts this program. Exit 3 when there is no such item, 4 when macOS or the
//       person said no.
//
// `--keychain` reads one keychain file and nothing else; without it, the user's search list (the
// login keychain). Realm passes it only from a test harness, never from a build someone uses.
import Foundation
import Security

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { exit(2) }
args.removeFirst()

func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

var scope: [String: Any] = [kSecClass as String: kSecClassInternetPassword]
if let path = option("--keychain") {
  var keychain: SecKeychain?
  guard SecKeychainOpen(path, &keychain) == errSecSuccess, let keychain else { exit(2) }
  scope[kSecMatchSearchList as String] = [keychain]
}
func with(_ a: [String: Any], _ b: [String: Any]) -> [String: Any] { a.merging(b) { _, new in new } }

/// The two protocols a browser pane can sign in over, as the keychain spells them.
let protocols: [String: String] = [kSecAttrProtocolHTTPS as String: "https", kSecAttrProtocolHTTP as String: "http"]

switch command {
case "list":
  var out: CFTypeRef?
  let status = SecItemCopyMatching(with(scope, [
    kSecReturnAttributes as String: true,
    kSecMatchLimit as String: kSecMatchLimitAll,
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
  ]) as CFDictionary, &out)
  if status == errSecItemNotFound { exit(0) }
  guard status == errSecSuccess, let items = out as? [[String: Any]] else { exit(4) }
  for item in items {
    guard let proto = item[kSecAttrProtocol as String] as? String, let scheme = protocols[proto],
          let server = item[kSecAttrServer as String] as? String, !server.isEmpty else { continue }
    let modified = (item[kSecAttrModificationDate as String] as? Date)?.timeIntervalSince1970 ?? 0
    let row: [String: Any] = [
      "server": server,
      "account": item[kSecAttrAccount as String] as? String ?? "",
      "protocol": scheme,
      "port": (item[kSecAttrPort as String] as? Int) ?? 0,
      "path": item[kSecAttrPath as String] as? String ?? "",
      "label": item[kSecAttrLabel as String] as? String ?? "",
      "modified": Int(modified * 1000),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: row), let line = String(data: data, encoding: .utf8) else { continue }
    print(line)
  }
  exit(0)

case "read":
  guard let server = option("--server"), let account = option("--account"), let scheme = option("--protocol"),
        let proto = protocols.first(where: { $0.value == scheme })?.key,
        let port = Int(option("--port") ?? ""), let path = option("--path") else { exit(2) }
  var query = with(scope, [
    kSecAttrServer as String: server,
    kSecAttrAccount as String: account,
    kSecAttrProtocol as String: proto,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ])
  if port > 0 { query[kSecAttrPort as String] = port }
  if !path.isEmpty { query[kSecAttrPath as String] = path }
  var out: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &out)
  if status == errSecItemNotFound { exit(3) }
  guard status == errSecSuccess, let data = out as? Data else { exit(4) }
  FileHandle.standardOutput.write(data)
  exit(0)

default:
  exit(2)
}

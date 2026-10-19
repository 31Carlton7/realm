import RealmKit
import UserNotifications

/// Opens a sealed push (PROTOCOL.md §4.3, §7) and rewrites the notification from it. If anything is
/// missing or does not open, the relay's placeholder is delivered as it came. There is never a
/// plaintext fallback.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        contentHandler(Self.opened(request.content) ?? request.content)
    }

    override func serviceExtensionTimeWillExpire() {
        // `didReceive` answers before it returns, so nothing is ever left waiting here.
    }

    static func opened(_ content: UNNotificationContent) -> UNNotificationContent? {
        let vault = Vault(store: KeychainStore())
        guard let identity = try? vault.identity(), let macs = try? vault.pairedMacs(),
              let payload = SealedPush.open(userInfo: content.userInfo, deviceKey: identity.dh,
                                            pairedMac: { id in macs.first { $0.macId == id } }),
              (try? vault.firstSighting(ofPush: payload.id)) == true,
              let rewritten = content.mutableCopy() as? UNMutableNotificationContent else { return nil }
        rewritten.title = payload.title
        rewritten.body = payload.body
        // The kind names the category the app registered, which says what the moment is when
        // previews are hidden.
        rewritten.categoryIdentifier = payload.kind
        if let session = payload.session {
            rewritten.threadIdentifier = session
            rewritten.userInfo["session"] = session
        }
        return rewritten
    }
}

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
        // The category the app registered for it: what the moment is when previews are hidden, and the
        // answers it offers. Those answer with the session and the request left in `userInfo`.
        rewritten.categoryIdentifier = NotificationAnswer.category(of: payload)
        if let session = payload.session { rewritten.threadIdentifier = session }
        for (key, value) in NotificationAnswer.userInfo(of: payload) { rewritten.userInfo[key] = value }
        return rewritten
    }
}

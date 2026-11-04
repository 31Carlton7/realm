import RealmKit
import SwiftUI
import UIKit

/// The share sheet's Realm: what was shared, copied into the inbox as it loads, and where it goes.
/// Sending commits the share and opens the app on it; Cancel leaves nothing behind.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let inbox = ShareInbox.shared()
        let draft = ShareDraft(inbox: inbox)
        draft.load(providers)
        let host = UIHostingController(rootView: ShareView(draft: draft, targets: inbox?.loadTargets(), send: { [weak self] target in
            self?.send(draft, to: target)
        }, cancel: { [weak self] in
            draft.discard()
            self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func send(_ draft: ShareDraft, to target: ShareTarget) {
        do {
            try draft.commit(to: target)
        } catch {
            draft.problem = "Realm could not keep this share. \(error.localizedDescription)"
            return
        }
        if let link = URL(string: "realm-mobile://share") { openRealm(link) }
        extensionContext?.completeRequest(returningItems: nil)
    }

    /// The extension's own scene opens the app: there is no call for it on the extension's context. Where
    /// it does not, the app takes the share the next time it comes to the front.
    private func openRealm(_ url: URL) {
        view.window?.windowScene?.open(url, options: nil)
    }
}

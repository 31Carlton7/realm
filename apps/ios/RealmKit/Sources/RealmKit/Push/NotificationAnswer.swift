import Foundation

/// An answer given from a push's notification, without opening the app (PROTOCOL.md §4.3): a decision
/// on a permission, sent with `session.answer`, or a reply to a session, sent with `session.send`.
public enum NotificationAnswer: Equatable, Sendable {
    case decide(session: String, request: String, Decision)
    case reply(session: String, text: String)

    /// The categories a Mac names in a push's `category`, each offering its own answers.
    public static let categories: Set<String> = ["permission", "permission.space", "permission.site", "reply"]

    /// The action identifiers the app registers. The decisions are named as `session.answer` names them.
    public enum Action {
        public static let allow = Decision.allow.rawValue
        public static let allowAlways = Decision.allowAlways.rawValue
        public static let deny = Decision.deny.rawValue
        public static let reply = "reply"
    }

    /// The category a push's notification is filed under: the one the Mac named, if this app knows it,
    /// and otherwise the push's kind, which answers nothing from the notification.
    public static func category(of payload: PushPayload) -> String {
        guard let category = payload.category, categories.contains(category) else { return payload.kind }
        // A permission's answers need its request; without one it is only read.
        if category != "reply", payload.request == nil { return payload.kind }
        return category
    }

    /// What the extension leaves in the notification's `userInfo` for an action to answer with.
    public static func userInfo(of payload: PushPayload) -> [String: String] {
        var info: [String: String] = [:]
        info["session"] = payload.session
        info["request"] = payload.request
        return info
    }

    /// The answer an action stands for, from the notification it was chosen on; nil for a plain tap,
    /// a dismissal, or a notification without what the action needs.
    public init?(action: String, userInfo: [AnyHashable: Any], text: String? = nil) {
        guard let session = userInfo["session"] as? String else { return nil }
        if action == Action.reply {
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            self = .reply(session: session, text: text)
            return
        }
        guard let decision = Decision(rawValue: action), let request = userInfo["request"] as? String else { return nil }
        self = .decide(session: session, request: request, decision)
    }

    public var session: String {
        switch self {
        case .decide(let session, _, _), .reply(let session, _): session
        }
    }
}

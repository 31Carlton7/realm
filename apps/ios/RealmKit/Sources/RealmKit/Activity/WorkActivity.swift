import Foundation

/// What a session's Live Activity says while it works, and once it has finished: the ActivityKit
/// content state, sent to the widget extension as it changes. The words are worked out in the app,
/// which has the transcript; the extension only draws them.
public struct WorkActivityContent: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Sendable {
        case working
        /// A request waits on the person, or the turn ended on something they have to answer.
        case needsYou
        case done
        case failed
    }

    public var phase: Phase
    /// The plan's item under way, else the turn's step; what is asked when it needs you.
    public var step: String
    /// How far the agent's plan has got, when it keeps one.
    public var done: Int?
    public var total: Int?
    /// When the turn began, which the clock counts from.
    public var startedAt: Date
    /// When it finished: the clock stops there.
    public var endedAt: Date?

    public init(phase: Phase, step: String, done: Int? = nil, total: Int? = nil, startedAt: Date, endedAt: Date? = nil) {
        self.phase = phase
        self.step = step
        self.done = done
        self.total = total
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    /// "2 of 5", with the plan; nil without one.
    public var count: String? {
        guard let done, let total, total > 0 else { return nil }
        return "\(done) of \(total)"
    }

    public var progress: Double? {
        guard let done, let total, total > 0 else { return nil }
        return Double(done) / Double(total)
    }

    /// Amber is the activity's only colour, as it is the sidebar's: for needs you and failed.
    public var isAmber: Bool { phase == .needsYou || phase == .failed }

    /// The activity has ended on this state, and leaves the Lock Screen after `dismissal`.
    public var isFinal: Bool { endedAt != nil }

    /// The state's word beside the step, where the step alone does not say it.
    public var label: String? { phase == .needsYou ? "Needs you" : nil }

    /// How long the turn ran, once it has finished.
    public var elapsed: String? { endedAt.map { TurnClock.words($0.timeIntervalSince(startedAt)) } }

    /// How long a finished activity stays on the Lock Screen.
    public static let dismissal: TimeInterval = 60

    /// The state for a session as it stands. `status` is the transcript's while the session is open
    /// here, else its Home row's; `step` is the turn's current step; `request` the title of the request
    /// waiting on the person. Nil while there is nothing to say yet: the message was sent and the Mac
    /// has not started the turn.
    public static func of(status: SessionStatus?, needsYou: Bool, step: String?, request: String?,
                          plan: TodoProgress?, startedAt: Date, now: Date = Date()) -> WorkActivityContent? {
        let plan = plan.flatMap { $0.total > 0 ? $0 : nil }
        let done = plan?.done, total = plan?.total
        switch status {
        case .running, .moving:
            return WorkActivityContent(phase: .working, step: plan?.activeWords ?? step ?? "Working",
                                       done: done, total: total, startedAt: startedAt)
        case .waiting:
            return WorkActivityContent(phase: .needsYou, step: request ?? "Waiting for your answer",
                                       done: done, total: total, startedAt: startedAt)
        case .idle, .ended:
            if needsYou {
                return WorkActivityContent(phase: .needsYou, step: request ?? "Turn ended",
                                           done: done, total: total, startedAt: startedAt, endedAt: now)
            }
            return WorkActivityContent(phase: .done, step: "Done", done: done, total: total,
                                       startedAt: startedAt, endedAt: now)
        case .error:
            return WorkActivityContent(phase: .failed, step: "Failed", done: done, total: total,
                                       startedAt: startedAt, endedAt: now)
        case .other, nil:
            return nil
        }
    }
}

/// A turn's clock, as the work dock counts it: "00:16", "12:03", "1:02:03".
public enum TurnClock {
    public static func words(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60)
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, seconds) : String(format: "%02d:%02d", minutes, seconds)
    }
}

/// When a session's Live Activity starts and ends.
public enum WorkActivityRules {
    public enum Trigger: Sendable {
        /// The person sent a message in the session.
        case sent
        /// The session they are looking at started a turn.
        case startedWhileViewing
    }

    /// One activity per session, and only with the person's Show on Lock Screen and the system's
    /// permission. A message sent while one is live keeps it.
    public static func shouldStart(_ trigger: Trigger, enabled: Bool, allowed: Bool, live: Bool) -> Bool {
        enabled && allowed && !live
    }

    /// A state that arrived before the turn began does not end the activity: the session was idle
    /// when the message went, and stays so until the Mac starts the turn. Once it has run, idle is the
    /// end of the turn.
    public static func ends(_ content: WorkActivityContent, turnSeen: Bool) -> Bool {
        content.isFinal && turnSeen
    }
}

/// `realm-mobile://session/<id>`: what a tap on a session's Live Activity opens.
public enum SessionLink {
    public static func url(_ sessionId: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "realm-mobile"
        parts.host = "session"
        parts.path = "/\(sessionId)"
        return parts.url
    }

    public static func sessionId(in url: URL) -> String? {
        guard url.scheme == "realm-mobile", url.host() == "session" else { return nil }
        let id = url.path(percentEncoded: false).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return id.isEmpty ? nil : id
    }
}

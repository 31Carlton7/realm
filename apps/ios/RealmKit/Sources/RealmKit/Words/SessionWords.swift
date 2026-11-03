import Foundation

extension SessionStatus {
    /// The status's symbol, drawn beside its word: the word carries it, the symbol is found by shape.
    public var symbol: String {
        switch self {
        case .idle: "pause.circle"
        case .running: "play.circle"
        case .waiting: "hand.raised"
        case .error: "exclamationmark.triangle"
        case .ended: "stop.circle"
        case .moving: "arrow.right.circle"
        case .other: "questionmark.circle"
        }
    }
}

/// How long ago a session moved, as the desktop says it: "just now", "4m ago", "2h ago", "3d ago",
/// then the date.
public enum Ago {
    public static func text(_ millis: Millis, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000)
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        let minutes = Int((seconds / 60).rounded(.down))
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days < 7 { return "\(days)d ago" }
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
        if calendar.component(.year, from: date) != calendar.component(.year, from: now) { style = style.year() }
        return date.formatted(style)
    }
}

/// The agents' names as the desktop shows them (`AGENT_META` in packages/contracts/src/presets.ts). A
/// test reads that file and fails when the two disagree.
public enum AgentNames {
    public static let labels: [String: String] = [
        "claude": "Claude",
        "codex": "Codex",
        "acp:gemini": "Gemini",
        "acp:cursor": "Cursor",
        "acp:opencode": "OpenCode",
        "acp:copilot": "GitHub Copilot",
        "acp:goose": "goose",
        "acp:qwen": "Qwen Code",
        "acp:grok": "Grok",
        "acp:fx": "fx",
        "acp:deepseek": "DeepSeek",
        "acp:openhands": "OpenHands",
        "acp:hermes": "Hermes",
        "fake": "Fake agent",
    ]

    /// An agent this table does not know is named by its kind, without the `acp:` prefix.
    public static func label(_ kind: String) -> String {
        if let label = labels[kind] { return label }
        let bare = kind.hasPrefix("acp:") ? String(kind.dropFirst(4)) : kind
        return bare.prefix(1).uppercased() + bare.dropFirst()
    }
}

/// What a lead's row says of its sub-agents, as the desktop's sidebar row says it: how many are its,
/// or, while any waits on a request, how many need you, and the one the row then opens on.
public struct RowSubagents: Sendable, Equatable {
    public let count: Int
    public let waiting: Int
    /// The sessions a press on the row opens, the lead first: and over it the sub-agent that has waited
    /// longest, where one waits, so the way back from its request leads to the lead.
    public let opens: [String]

    /// Nil for a row with none, and for every row from a Mac that does not say.
    public init?(_ row: SessionRow) {
        guard let count = row.subagents, count > 0 else { return nil }
        self.count = count
        waiting = min(max(row.subagentsWaiting ?? 0, 0), count)
        if waiting > 0, let longest = row.subagentWaiting {
            opens = [row.id, longest]
        } else {
            opens = [row.id]
        }
    }

    /// "2 sub-agents"; while any waits, "1 sub-agent needs you", "2 sub-agents need you".
    public var words: String {
        if waiting > 0 { return waiting == 1 ? "1 sub-agent needs you" : "\(waiting) sub-agents need you" }
        return count == 1 ? "1 sub-agent" : "\(count) sub-agents"
    }
}

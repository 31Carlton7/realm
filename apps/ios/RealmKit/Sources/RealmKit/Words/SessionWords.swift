import Foundation

extension SessionStatus {
    /// The status's symbol, drawn beside its word: the word carries it, the symbol is found by shape.
    public var symbol: String {
        switch self {
        case .idle: "circle"
        case .running: "play.circle"
        case .waiting: "hand.raised"
        case .error: "exclamationmark.triangle"
        case .ended: "stop.circle"
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

import Foundation

/// How a teammate is said on the phone, as its sidebar row, its chat's head and a transcript's message
/// to it say it on the Mac.
public enum TeammateWords {
    /// The one line of what a teammate does: its brief's first line with any Markdown mark taken off its
    /// start, as the chat's head shows it (`briefLine`).
    public static func role(_ brief: String) -> String {
        for line in brief.split(separator: "\n", omittingEmptySubsequences: false) {
            let words = line.drop { "#>*- \t".contains($0) }.trimmingCharacters(in: .whitespaces)
            if !words.isEmpty { return words }
        }
        return ""
    }

    /// A handle from a name, as the Mac makes one: `Design Engineer` → `design-engineer`. Never empty
    /// (`teammateHandle`).
    public static func handle(from name: String) -> String {
        let plain = name.decomposedStringWithCompatibilityMapping.unicodeScalars
            .filter { !(0x300...0x36F).contains($0.value) }
        var out = ""
        var dash = false
        for scalar in String(String.UnicodeScalarView(plain)).lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                if dash && !out.isEmpty { out.append("-") }
                out.unicodeScalars.append(scalar)
                dash = false
            } else {
                dash = true
            }
        }
        let cut = String(out.prefix(40))
        let trimmed = String(cut.reversed().drop { $0 == "-" }.reversed())
        return trimmed.isEmpty ? "teammate" : trimmed
    }

    /// Why a handle typed on the phone is not one, in the Mac's words; nil for a good one
    /// (`TeammateHandleSchema`).
    public static func handleProblem(_ handle: String) -> String? {
        handle.wholeMatch(of: /[a-z0-9][a-z0-9-]{0,39}/) == nil ? "a handle is lowercase letters, digits and dashes" : nil
    }

    /// The state in words where it is worth saying: what the row's dot means.
    public static func state(_ state: TeammateState?) -> String? {
        switch state {
        case .working: "Working"
        case .needsYou: "Needs you"
        case .idle, nil: nil
        }
    }

    /// What VoiceOver says for a teammate's row: who, whether it is the Lead, how it stands, and what
    /// it is doing.
    public static func spoken(_ teammate: Teammate) -> String {
        var parts = [teammate.name]
        if teammate.lead { parts.append("the Lead") }
        if let state = state(teammate.state) { parts.append(state) }
        if teammate.unread == true { parts.append("Unread") }
        if let activity = teammate.activity { parts.append(activity) } else if !role(teammate.brief).isEmpty { parts.append(role(teammate.brief)) }
        return parts.joined(separator: ", ")
    }
}

/// Where a message to a teammate stands, as its line in the sender's transcript says it.
public enum TeammateCallState: Sendable, Hashable {
    case working, needsYou, done

    public var word: String {
        switch self {
        case .working: "Working"
        case .needsYou: "Needs you"
        case .done: "Done"
        }
    }

    /// The newest message to a teammate says what it is doing now, from the state its row reads; one
    /// still waiting on its answer is working whatever that says; any other was answered or overtaken
    /// (`teammateCallState`).
    public init(call: ToolState, teammate: Teammate?, newest: Bool) {
        if call == .running {
            self = teammate?.state == .needsYou ? .needsYou : .working
            return
        }
        switch (newest ? teammate?.state : nil) {
        case .working?: self = .working
        case .needsYou?: self = .needsYou
        default: self = .done
        }
    }

    /// The newest message to each teammate in these rows, by row key (`newestTeammateCalls`).
    public static func newest(in rows: [TranscriptRow]) -> Set<String> {
        var latest: [String: String] = [:]
        for row in rows {
            guard let call = row.teammateCall else { continue }
            latest[call.id ?? "@\(call.handle)"] = row.key
        }
        return Set(latest.values)
    }
}

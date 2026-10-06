import Foundation

// mobile.v1, Phase 1 subset (PROTOCOL.md §8). Readers ignore fields they do not know; a row kind this
// phone does not know decodes to `.unknown`, never to a failure.

/// Unix milliseconds. JSON numbers decode whole or fractional.
public typealias Millis = Double

public enum SessionStatus: Sendable, Hashable, Codable {
    case idle, running, waiting, error, ended
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "idle": self = .idle
        case "running": self = .running
        case "waiting": self = .waiting
        case "error": self = .error
        case "ended": self = .ended
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .idle: "idle"
        case .running: "running"
        case .waiting: "waiting"
        case .error: "error"
        case .ended: "ended"
        case .other(let value): value
        }
    }

    /// The status as a word, never as colour alone.
    public var word: String {
        switch self {
        case .idle: "Idle"
        case .running: "Running"
        case .waiting: "Waiting on you"
        case .error: "Failed"
        case .ended: "Ended"
        case .other(let value): value.capitalized
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// One session in a list.
public struct SessionRow: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let title: String
    public let spaceId: String
    public let spaceName: String
    public let agent: String
    public let model: String?
    public let status: SessionStatus
    public let needsYou: Bool
    public let unread: Bool
    public let updatedAt: Millis

    public init(id: String, title: String, spaceId: String, spaceName: String, agent: String, model: String?,
                status: SessionStatus, needsYou: Bool, unread: Bool, updatedAt: Millis) {
        self.id = id
        self.title = title
        self.spaceId = spaceId
        self.spaceName = spaceName
        self.agent = agent
        self.model = model
        self.status = status
        self.needsYou = needsYou
        self.unread = unread
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, spaceId, spaceName, agent, model, status, needsYou, unread, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        spaceId = (try? c.decodeIfPresent(String.self, forKey: .spaceId)) ?? ""
        spaceName = (try? c.decodeIfPresent(String.self, forKey: .spaceName)) ?? ""
        agent = (try? c.decodeIfPresent(String.self, forKey: .agent)) ?? ""
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        status = (try? c.decodeIfPresent(SessionStatus.self, forKey: .status)) ?? .other("unknown")
        needsYou = (try? c.decodeIfPresent(Bool.self, forKey: .needsYou)) ?? false
        unread = (try? c.decodeIfPresent(Bool.self, forKey: .unread)) ?? false
        updatedAt = (try? c.decodeIfPresent(Millis.self, forKey: .updatedAt)) ?? 0
    }
}

public struct QuestionOption: Decodable, Sendable, Hashable {
    public let label: String
    public let description: String?
}

public struct Question: Decodable, Sendable, Hashable {
    public let question: String
    public let header: String
    public let multiSelect: Bool
    public let options: [QuestionOption]

    private enum CodingKeys: String, CodingKey { case question, header, multiSelect, options }

    public init(question: String, header: String, multiSelect: Bool, options: [QuestionOption]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        options = (try? c.decodeIfPresent([QuestionOption].self, forKey: .options)) ?? []
    }
}

public struct PlanStep: Decodable, Sendable, Hashable {
    public let text: String
    public let status: String
}

public enum ToolState: String, Decodable, Sendable, Hashable {
    case running, done, error
}

public enum RequestState: String, Decodable, Sendable, Hashable {
    case pending, allowed, denied
}

/// One thing in a session's transcript. `key` names it; a later row with the same key replaces it.
public struct TranscriptRow: Decodable, Sendable, Hashable, Identifiable {
    public enum Content: Sendable, Hashable {
        case user(text: String)
        case assistant(text: String, streaming: Bool)
        case thinking(text: String)
        case tool(name: String, summary: String, state: ToolState, detail: String?)
        case request(Request)
        case plan(text: String?, steps: [PlanStep]?)
        case notice(text: String)
        case error(text: String, hint: String?)
        /// A row this phone cannot draw: `kind` as sent, and `type` when the Mac named the event.
        case unknown(kind: String, type: String?)
    }

    public struct Request: Sendable, Hashable {
        public let requestId: String
        public let tool: String
        public let title: String
        public let summary: String
        public let state: RequestState
        public let questions: [Question]?
    }

    public let key: String
    public let seq: Int
    public let content: Content

    public var id: String { key }

    public init(key: String, seq: Int, content: Content) {
        self.key = key
        self.seq = seq
        self.content = content
    }

    private enum CodingKeys: String, CodingKey {
        case key, seq, kind, type
        case text, streaming, name, summary, state, detail
        case requestId, tool, title, questions, steps, hint
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        if let whole = try? c.decode(Int.self, forKey: .seq) {
            seq = whole
        } else {
            seq = Int((try? c.decode(Double.self, forKey: .seq)) ?? 0)
        }
        let kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        let type = try? c.decodeIfPresent(String.self, forKey: .type)
        // A kind this phone knows but whose fields do not parse is drawn as unknown, not dropped.
        content = (try? Self.decodeContent(kind: kind, c)) ?? .unknown(kind: kind, type: type)
    }

    private static func decodeContent(kind: String, _ c: KeyedDecodingContainer<CodingKeys>) throws -> Content {
        switch kind {
        case "user":
            return .user(text: try c.decode(String.self, forKey: .text))
        case "assistant":
            return .assistant(text: try c.decode(String.self, forKey: .text),
                              streaming: (try c.decodeIfPresent(Bool.self, forKey: .streaming)) ?? false)
        case "thinking":
            return .thinking(text: try c.decode(String.self, forKey: .text))
        case "tool":
            return .tool(name: try c.decode(String.self, forKey: .name),
                         summary: (try c.decodeIfPresent(String.self, forKey: .summary)) ?? "",
                         state: try c.decode(ToolState.self, forKey: .state),
                         detail: try c.decodeIfPresent(String.self, forKey: .detail))
        case "request":
            return .request(Request(
                requestId: try c.decode(String.self, forKey: .requestId),
                tool: (try c.decodeIfPresent(String.self, forKey: .tool)) ?? "",
                title: (try c.decodeIfPresent(String.self, forKey: .title)) ?? "",
                summary: (try c.decodeIfPresent(String.self, forKey: .summary)) ?? "",
                state: try c.decode(RequestState.self, forKey: .state),
                questions: try c.decodeIfPresent([Question].self, forKey: .questions)
            ))
        case "plan":
            return .plan(text: try c.decodeIfPresent(String.self, forKey: .text),
                         steps: try c.decodeIfPresent([PlanStep].self, forKey: .steps))
        case "notice":
            return .notice(text: try c.decode(String.self, forKey: .text))
        case "error":
            return .error(text: try c.decode(String.self, forKey: .text),
                          hint: try c.decodeIfPresent(String.self, forKey: .hint))
        default:
            return .unknown(kind: kind, type: try? c.decodeIfPresent(String.self, forKey: .type))
        }
    }
}

public struct MacInfo: Decodable, Sendable, Hashable {
    public let name: String
}

public struct Space: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let icon: JSONValue?
    public let color: JSONValue?
    public let sessions: [SessionRow]
    public let more: Int

    private enum CodingKeys: String, CodingKey { case id, name, icon, color, sessions, more }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        icon = try? c.decodeIfPresent(JSONValue.self, forKey: .icon)
        color = try? c.decodeIfPresent(JSONValue.self, forKey: .color)
        sessions = try c.decodeIfPresent([SessionRow].self, forKey: .sessions) ?? []
        more = (try? c.decodeIfPresent(Int.self, forKey: .more)) ?? 0
    }
}

/// `home.get`
public struct Home: Decodable, Sendable, Hashable {
    public let mac: MacInfo
    public let needsYou: [SessionRow]
    public let spaces: [Space]
}

/// `session.open`
public struct OpenedSession: Decodable, Sendable, Hashable {
    public let session: SessionRow
    public let rows: [TranscriptRow]
    public let hasMore: Bool
}

/// `ping`
public struct Pong: Decodable, Sendable, Hashable {
    public let at: Millis
}

/// `{ok: true}`
public struct Acknowledged: Decodable, Sendable, Hashable {
    public let ok: Bool
}

/// `session.create`
public struct CreatedSession: Decodable, Sendable, Hashable {
    public let id: String
}

public enum Delivery: String, Codable, Sendable {
    case auto, queue, steer
}

public enum Decision: String, Codable, Sendable {
    case allow
    case allowAlways = "allow_always"
    case deny
}

// MARK: - Events

public struct SessionRowsEvent: Decodable, Sendable {
    public let id: String
    public let rows: [TranscriptRow]
}

public struct SessionStatusEvent: Decodable, Sendable {
    public let id: String
    public let status: SessionStatus
}

/// `pair.result` (§4.1).
public struct PairResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let phoneId: String?
    public let reason: String?
}

public enum MobileEvent: Sendable {
    case sessionRows(SessionRowsEvent)
    case sessionStatus(SessionStatusEvent)
    case homeChanged
    case pairResult(PairResult)
    /// An event this phone does not know, or one whose payload did not parse.
    case unknown(name: String)
}

extension Question {
    /// `session.answer`'s `answers` from what was picked: question text → label, several labels of a
    /// multi-select question joined with ", " in the order the options list them, as the desktop does.
    /// Questions with nothing picked are left out.
    public static func answers(_ questions: [Question], picks: [String: Set<String>]) -> [String: String] {
        var answers: [String: String] = [:]
        for question in questions where answers[question.question] == nil {
            let chosen = question.options.map(\.label).filter { picks[question.question]?.contains($0) == true }
            if !chosen.isEmpty { answers[question.question] = chosen.joined(separator: ", ") }
        }
        return answers
    }
}

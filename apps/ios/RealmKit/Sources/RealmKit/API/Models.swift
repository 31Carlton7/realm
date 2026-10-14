import Foundation

// mobile.v1, Phase 1 subset (PROTOCOL.md §8). Readers ignore fields they do not know; a row kind this
// phone does not know decodes to `.unknown`, never to a failure.
//
// Everything here encodes back to the wire's own shape, so the cache on disk is read by the same
// decoders as the Mac's answers.

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
public struct SessionRow: Codable, Sendable, Hashable, Identifiable {
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

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(spaceId, forKey: .spaceId)
        try c.encode(spaceName, forKey: .spaceName)
        try c.encode(agent, forKey: .agent)
        try c.encode(model, forKey: .model)
        try c.encode(status, forKey: .status)
        try c.encode(needsYou, forKey: .needsYou)
        try c.encode(unread, forKey: .unread)
        try c.encode(updatedAt, forKey: .updatedAt)
    }
}

public struct QuestionOption: Codable, Sendable, Hashable {
    public let label: String
    public let description: String?

    public init(label: String, description: String?) {
        self.label = label
        self.description = description
    }
}

public struct Question: Codable, Sendable, Hashable {
    public let question: String
    public let header: String
    public let multiSelect: Bool
    public let options: [QuestionOption]
    /// Whether an answer of the person's own is taken beside the options. The desktop's rule: yes
    /// unless the agent said no. A Mac that does not send it means yes.
    public let allowOther: Bool
    /// An answer the Mac keeps only a mark of. A Mac that does not send it means no.
    public let secret: Bool

    private enum CodingKeys: String, CodingKey { case question, header, multiSelect, options, allowOther, secret }

    public init(question: String, header: String, multiSelect: Bool, options: [QuestionOption],
                allowOther: Bool = true, secret: Bool = false) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
        self.allowOther = allowOther
        self.secret = secret
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        options = (try? c.decodeIfPresent([QuestionOption].self, forKey: .options)) ?? []
        allowOther = (try? c.decodeIfPresent(Bool.self, forKey: .allowOther)) ?? true
        secret = (try? c.decodeIfPresent(Bool.self, forKey: .secret)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(question, forKey: .question)
        try c.encode(header, forKey: .header)
        try c.encode(multiSelect, forKey: .multiSelect)
        try c.encode(options, forKey: .options)
        try c.encode(allowOther, forKey: .allowOther)
        try c.encode(secret, forKey: .secret)
    }

    /// A question with no options is answered in words alone.
    public var takesText: Bool { options.isEmpty || allowOther }
}

public struct PlanStep: Codable, Sendable, Hashable {
    public let text: String
    public let status: String

    public init(text: String, status: String) {
        self.text = text
        self.status = status
    }
}

public enum ToolState: String, Codable, Sendable, Hashable {
    case running, done, error
}

public enum RequestState: String, Codable, Sendable, Hashable {
    case pending, allowed, denied
}

/// One thing in a session's transcript. `key` names it; a later row with the same key replaces it.
public struct TranscriptRow: Codable, Sendable, Hashable, Identifiable {
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

        public init(requestId: String, tool: String, title: String, summary: String, state: RequestState, questions: [Question]?) {
            self.requestId = requestId
            self.tool = tool
            self.title = title
            self.summary = summary
            self.state = state
            self.questions = questions
        }

        /// What the card asks for: questions to answer, a plan to approve, or a permission.
        public var kind: RequestKind {
            if let questions, !questions.isEmpty { return .questions(questions) }
            if tool == "ExitPlanMode" { return .plan }
            return .permission
        }
    }

    public enum RequestKind: Sendable, Hashable {
        case permission
        /// `ExitPlanMode`: answering it is how a session leaves Plan, so it is a plan to approve, not a
        /// permission to grant.
        case plan
        case questions([Question])
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

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(seq, forKey: .seq)
        switch content {
        case .user(let text):
            try c.encode("user", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .assistant(let text, let streaming):
            try c.encode("assistant", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(streaming, forKey: .streaming)
        case .thinking(let text):
            try c.encode("thinking", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .tool(let name, let summary, let state, let detail):
            try c.encode("tool", forKey: .kind)
            try c.encode(name, forKey: .name)
            try c.encode(summary, forKey: .summary)
            try c.encode(state, forKey: .state)
            try c.encode(detail, forKey: .detail)
        case .request(let request):
            try c.encode("request", forKey: .kind)
            try c.encode(request.requestId, forKey: .requestId)
            try c.encode(request.tool, forKey: .tool)
            try c.encode(request.title, forKey: .title)
            try c.encode(request.summary, forKey: .summary)
            try c.encode(request.state, forKey: .state)
            try c.encode(request.questions, forKey: .questions)
        case .plan(let text, let steps):
            try c.encode("plan", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(steps, forKey: .steps)
        case .notice(let text):
            try c.encode("notice", forKey: .kind)
            try c.encode(text, forKey: .text)
        case .error(let text, let hint):
            try c.encode("error", forKey: .kind)
            try c.encode(text, forKey: .text)
            try c.encode(hint, forKey: .hint)
        case .unknown(let kind, let type):
            try c.encode(kind, forKey: .kind)
            try c.encodeIfPresent(type, forKey: .type)
        }
    }
}

public struct MacInfo: Codable, Sendable, Hashable {
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

public struct Space: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let icon: JSONValue?
    public let color: JSONValue?
    public let sessions: [SessionRow]
    public let more: Int

    private enum CodingKeys: String, CodingKey { case id, name, icon, color, sessions, more }

    public init(id: String, name: String, icon: JSONValue?, color: JSONValue?, sessions: [SessionRow], more: Int) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.sessions = sessions
        self.more = more
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        icon = try? c.decodeIfPresent(JSONValue.self, forKey: .icon)
        color = try? c.decodeIfPresent(JSONValue.self, forKey: .color)
        sessions = try c.decodeIfPresent([SessionRow].self, forKey: .sessions) ?? []
        more = (try? c.decodeIfPresent(Int.self, forKey: .more)) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encode(sessions, forKey: .sessions)
        try c.encode(more, forKey: .more)
    }

    /// The space's emoji, when its icon is one (`emoji:<char>`). Other icons are Hugeicons glyphs and
    /// pictures, which this phone does not draw yet.
    public var emoji: String? {
        guard let icon = icon?.stringValue, icon.hasPrefix("emoji:") else { return nil }
        let char = String(icon.dropFirst("emoji:".count))
        return char.isEmpty ? nil : char
    }
}

/// `home.get`
public struct Home: Codable, Sendable, Hashable {
    public let mac: MacInfo
    public let needsYou: [SessionRow]
    public let spaces: [Space]

    public init(mac: MacInfo, needsYou: [SessionRow], spaces: [Space]) {
        self.mac = mac
        self.needsYou = needsYou
        self.spaces = spaces
    }
}

/// `session.open`
public struct OpenedSession: Codable, Sendable, Hashable {
    public let session: SessionRow
    public let rows: [TranscriptRow]
    public let hasMore: Bool

    public init(session: SessionRow, rows: [TranscriptRow], hasMore: Bool) {
        self.session = session
        self.rows = rows
        self.hasMore = hasMore
    }
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

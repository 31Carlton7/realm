import Foundation

// mobile.v1 (PROTOCOL.md §8). Readers ignore fields they do not know; a row kind this phone does not
// know decodes to `.unknown`, never to a failure. A field the Mac added after Phase 1 is optional here,
// and its absence means what Phase 1 meant.
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
    /// The agent as the desktop names it ("Claude", "GitHub Copilot"); nil from a Phase 1 Mac.
    public let agentName: String?
    /// The mark the desktop draws for the agent: a vendor's ("claude", "openai") or a glyph ("bot").
    public let agentMark: String?
    /// The model as the desktop's chip names it ("Opus 5.5"), or its default's name while none is pinned.
    public let modelLabel: String?
    /// When the session was made; nil from a Mac before Plan 29.
    public let createdAt: Millis?
    /// The reasoning level pinned on the session, or nil for the model's own.
    public let effort: String?
    /// As the desktop stores it: a permission rung ("default", "acceptEdits", "bypassPermissions"), or
    /// the mode the session is in instead ("plan", "ask"). Nil from a Mac before Plan 29.
    public let permissionMode: String?
    /// When the conversation last moved: a message went out, or the agent answered or finished a turn.
    /// Unlike `updatedAt`, a change of settings or a rename does not move it. Nil from a Mac before Plan 29.
    public let activityAt: Millis?

    public init(id: String, title: String, spaceId: String, spaceName: String, agent: String, model: String?,
                status: SessionStatus, needsYou: Bool, unread: Bool, updatedAt: Millis,
                agentName: String? = nil, agentMark: String? = nil, modelLabel: String? = nil,
                createdAt: Millis? = nil, effort: String? = nil, permissionMode: String? = nil, activityAt: Millis? = nil) {
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
        self.agentName = agentName
        self.agentMark = agentMark
        self.modelLabel = modelLabel
        self.createdAt = createdAt
        self.effort = effort
        self.permissionMode = permissionMode
        self.activityAt = activityAt
    }

    /// When the session last moved, as the Mac orders its lists: what a list of sessions is ordered by,
    /// and what a row's age says. An older Mac sends no `activityAt`, and its `updatedAt` stands in.
    public var lastActivity: Millis { activityAt ?? updatedAt }

    /// The agent's name: the Mac's, or this phone's own table where a Phase 1 Mac sent none.
    public var agentDisplayName: String { agentName ?? AgentNames.label(agent) }

    /// The model's name: the Mac's label, else its id; nil when neither is known.
    public var modelDisplayName: String? { modelLabel ?? model }

    private enum CodingKeys: String, CodingKey {
        case id, title, spaceId, spaceName, agent, model, status, needsYou, unread, updatedAt, agentName, agentMark, modelLabel
        case createdAt, effort, permissionMode, activityAt
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
        agentName = try? c.decodeIfPresent(String.self, forKey: .agentName)
        agentMark = try? c.decodeIfPresent(String.self, forKey: .agentMark)
        modelLabel = try? c.decodeIfPresent(String.self, forKey: .modelLabel)
        createdAt = try? c.decodeIfPresent(Millis.self, forKey: .createdAt)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        permissionMode = try? c.decodeIfPresent(String.self, forKey: .permissionMode)
        activityAt = try? c.decodeIfPresent(Millis.self, forKey: .activityAt)
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
        try c.encodeIfPresent(agentName, forKey: .agentName)
        try c.encodeIfPresent(agentMark, forKey: .agentMark)
        try c.encodeIfPresent(modelLabel, forKey: .modelLabel)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encodeIfPresent(permissionMode, forKey: .permissionMode)
        try c.encodeIfPresent(activityAt, forKey: .activityAt)
    }

    /// The mode the session is in, read from its stored permission mode. Nil where the Mac did not say.
    public var mode: SessionMode? {
        permissionMode.map(SessionMode.of)
    }
}

/// Build, Plan or Ask: whether the agent changes things, plans first, or only answers. Plan and Ask
/// travel in the session's permission mode, so a session in either is not storing its permission rung.
public enum SessionMode: String, Codable, Sendable, Hashable, CaseIterable {
    case build, plan, ask

    /// The mode a stored permission mode puts a session in: anything but Plan or Ask is a rung, so Build.
    public static func of(_ permissionMode: String) -> SessionMode {
        switch permissionMode {
        case "plan": .plan
        case "ask": .ask
        default: .build
        }
    }
}

public struct QuestionOption: Codable, Sendable, Hashable {
    public let label: String
    public let description: String?
    /// What choosing it answers, where that is not the label (an MCP form's enum). Nil means the label.
    public let value: String?

    public init(label: String, description: String?, value: String? = nil) {
        self.label = label
        self.description = description
        self.value = value
    }

    /// What the answer carries when this option is picked.
    public var answerValue: String { value ?? label }
}

/// An answer to one question, as the desktop's card hands it back: one value, or several.
public enum AnswerValue: Codable, Sendable, Hashable {
    case one(String)
    case several([String])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let one = try? container.decode(String.self) {
            self = .one(one)
        } else {
            self = .several(try container.decode([String].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .one(let value): try container.encode(value)
        case .several(let values): try container.encode(values)
        }
    }

    /// The answer as one line: several values joined with ", ", as the desktop's card writes them.
    public var text: String {
        switch self {
        case .one(let value): value
        case .several(let values): values.joined(separator: ", ")
        }
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
    /// The key its answer goes under. A Phase 1 Mac sends none, and keys answers by the question's text.
    public let id: String?
    /// What kind of question the desktop's card says it is: "choice", "multi", "text", "confirm", or
    /// one this phone cannot answer ("model", "file", "branch", "time", "link"). Nil from a Phase 1 Mac.
    public let kind: String?
    /// It cannot be skipped on its own.
    public let required: Bool
    /// A line under the question: what a field is for, in the asker's words.
    public let detail: String?
    public let placeholder: String?
    /// The answer the asker suggests, already picked.
    public let defaultAnswer: AnswerValue?

    private enum CodingKeys: String, CodingKey {
        case question, header, multiSelect, options, allowOther, secret, id, kind, required, detail, placeholder
        case defaultAnswer = "default"
    }

    public init(question: String, header: String, multiSelect: Bool, options: [QuestionOption],
                allowOther: Bool = true, secret: Bool = false, id: String? = nil, kind: String? = nil, required: Bool = false,
                detail: String? = nil, placeholder: String? = nil, defaultAnswer: AnswerValue? = nil) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
        self.allowOther = allowOther
        self.secret = secret
        self.id = id
        self.kind = kind
        self.required = required
        self.detail = detail
        self.placeholder = placeholder
        self.defaultAnswer = defaultAnswer
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        options = (try? c.decodeIfPresent([QuestionOption].self, forKey: .options)) ?? []
        allowOther = (try? c.decodeIfPresent(Bool.self, forKey: .allowOther)) ?? true
        secret = (try? c.decodeIfPresent(Bool.self, forKey: .secret)) ?? false
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        required = (try? c.decodeIfPresent(Bool.self, forKey: .required)) ?? false
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        placeholder = try? c.decodeIfPresent(String.self, forKey: .placeholder)
        defaultAnswer = try? c.decodeIfPresent(AnswerValue.self, forKey: .defaultAnswer)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(question, forKey: .question)
        try c.encode(header, forKey: .header)
        try c.encode(multiSelect, forKey: .multiSelect)
        try c.encode(options, forKey: .options)
        try c.encode(allowOther, forKey: .allowOther)
        try c.encode(secret, forKey: .secret)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encodeIfPresent(kind, forKey: .kind)
        if required { try c.encode(required, forKey: .required) }
        try c.encodeIfPresent(detail, forKey: .detail)
        try c.encodeIfPresent(placeholder, forKey: .placeholder)
        try c.encodeIfPresent(defaultAnswer, forKey: .defaultAnswer)
    }

    /// A question with no options is answered in words alone.
    public var takesText: Bool { options.isEmpty || allowOther }

    /// The key `session.answer` puts its answer under.
    public var answerKey: String { id ?? question }

    /// The kinds this phone answers itself. The rest need the Mac's own pickers (a model, a file, a
    /// branch, a date) or a page opened on it, and say so.
    public var isAnswerableHere: Bool {
        guard let kind else { return true }
        return ["choice", "multi", "text", "confirm"].contains(kind)
    }
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
        /// Who asks the questions: the agent's name, or "<name>'s MCP server".
        public let asker: String?
        /// What the asker said the questions are for.
        public let message: String?
        /// The answers given, once there are some, by question key — a secret one only as its mark.
        public let answers: [String: AnswerValue]?
        /// On a plan to approve (`ExitPlanMode`): the plan's text, and its steps where the agent kept them.
        public let plan: PendingPlan?

        public init(requestId: String, tool: String, title: String, summary: String, state: RequestState, questions: [Question]?,
                    asker: String? = nil, message: String? = nil, answers: [String: AnswerValue]? = nil, plan: PendingPlan? = nil) {
            self.requestId = requestId
            self.tool = tool
            self.title = title
            self.summary = summary
            self.state = state
            self.questions = questions
            self.asker = asker
            self.message = message
            self.answers = answers
            self.plan = plan
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
    /// A notice of a turn's changes: the checkpoint `session.changes` opens them by.
    public let checkpointId: String?
    /// A notice of the files a turn made: each by its path on the Mac, which `session.file` previews.
    public let madeFiles: [MadeFile]?
    /// What the person sent with a message, each file by its path on the Mac, which `session.file`
    /// previews. Nil from a Mac before Plan 29, and on every other kind of row.
    public let sentFiles: [SentFile]?

    public var id: String { key }

    public init(key: String, seq: Int, content: Content, checkpointId: String? = nil, madeFiles: [MadeFile]? = nil,
                sentFiles: [SentFile]? = nil) {
        self.key = key
        self.seq = seq
        self.content = content
        self.checkpointId = checkpointId
        self.madeFiles = madeFiles
        self.sentFiles = sentFiles
    }

    private enum CodingKeys: String, CodingKey {
        case key, seq, kind, type
        case text, streaming, name, summary, state, detail
        case requestId, tool, title, questions, steps, hint
        case asker, message, answers, plan, checkpointId, files
        case sentFiles = "attachments"
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
        checkpointId = try? c.decodeIfPresent(String.self, forKey: .checkpointId)
        madeFiles = try? c.decodeIfPresent([MadeFile].self, forKey: .files)
        sentFiles = try? c.decodeIfPresent([SentFile].self, forKey: .sentFiles)
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
                questions: try c.decodeIfPresent([Question].self, forKey: .questions),
                asker: try? c.decodeIfPresent(String.self, forKey: .asker),
                message: try? c.decodeIfPresent(String.self, forKey: .message),
                answers: try? c.decodeIfPresent([String: AnswerValue].self, forKey: .answers),
                plan: try? c.decodeIfPresent(PendingPlan.self, forKey: .plan)
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
            try c.encodeIfPresent(request.asker, forKey: .asker)
            try c.encodeIfPresent(request.message, forKey: .message)
            try c.encodeIfPresent(request.answers, forKey: .answers)
            try c.encodeIfPresent(request.plan, forKey: .plan)
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
        try c.encodeIfPresent(checkpointId, forKey: .checkpointId)
        try c.encodeIfPresent(madeFiles, forKey: .files)
        try c.encodeIfPresent(sentFiles, forKey: .sentFiles)
    }
}

/// A file sent with a message, by its path on the Mac.
public struct SentFile: Codable, Sendable, Hashable {
    public let path: String
    public let name: String
    public let mime: String

    public init(path: String, name: String, mime: String) {
        self.path = path
        self.name = name
        self.mime = mime
    }

    public var isImage: Bool { mime.hasPrefix("image/") }
}

/// The plan a request asks to have approved.
public struct PendingPlan: Codable, Sendable, Hashable {
    public let text: String?
    public let steps: [PlanStep]?

    public init(text: String?, steps: [PlanStep]?) {
        self.text = text
        self.steps = steps
    }
}

/// A file a turn made, by its path on the Mac.
public struct MadeFile: Codable, Sendable, Hashable {
    public let path: String
    public let size: Double

    public init(path: String, size: Double) {
        self.path = path
        self.size = size
    }

    /// The file's own name, the last part of its path.
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

public struct MacInfo: Codable, Sendable, Hashable {
    public let name: String

    public init(name: String) {
        self.name = name
    }
}

/// What a space's icon is, as the desktop reads it.
public enum SpaceIconKind: Sendable, Hashable, Codable {
    /// A Hugeicons glyph, by name (`Space.glyph`).
    case glyph
    case emoji
    /// The person's own picture, which `space.icon` sends.
    case picture
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "glyph": self = .glyph
        case "emoji": self = .emoji
        case "picture": self = .picture
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .glyph: "glyph"
        case .emoji: "emoji"
        case .picture: "picture"
        case .other(let value): value
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

public struct Space: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let icon: JSONValue?
    public let color: JSONValue?
    public let sessions: [SessionRow]
    public let more: Int
    /// What `icon` is; nil from a Phase 1 Mac.
    public let iconKind: SpaceIconKind?
    /// The glyph's name, when the icon is a glyph.
    public let glyph: String?
    /// The emoji as the Mac sent it.
    private let sentEmoji: String?
    /// The profile the space belongs to; nil from a Mac before Plan 29.
    public let profileId: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, icon, color, sessions, more, iconKind, glyph, profileId
        case sentEmoji = "emoji"
    }

    public init(id: String, name: String, icon: JSONValue?, color: JSONValue?, sessions: [SessionRow], more: Int,
                iconKind: SpaceIconKind? = nil, glyph: String? = nil, emoji: String? = nil, profileId: String? = nil) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.sessions = sessions
        self.more = more
        self.iconKind = iconKind
        self.glyph = glyph
        self.sentEmoji = emoji
        self.profileId = profileId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        icon = try? c.decodeIfPresent(JSONValue.self, forKey: .icon)
        color = try? c.decodeIfPresent(JSONValue.self, forKey: .color)
        sessions = try c.decodeIfPresent([SessionRow].self, forKey: .sessions) ?? []
        more = (try? c.decodeIfPresent(Int.self, forKey: .more)) ?? 0
        iconKind = try? c.decodeIfPresent(SpaceIconKind.self, forKey: .iconKind)
        glyph = try? c.decodeIfPresent(String.self, forKey: .glyph)
        sentEmoji = try? c.decodeIfPresent(String.self, forKey: .sentEmoji)
        profileId = try? c.decodeIfPresent(String.self, forKey: .profileId)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(icon, forKey: .icon)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encode(sessions, forKey: .sessions)
        try c.encode(more, forKey: .more)
        try c.encodeIfPresent(iconKind, forKey: .iconKind)
        try c.encodeIfPresent(glyph, forKey: .glyph)
        try c.encodeIfPresent(sentEmoji, forKey: .sentEmoji)
        try c.encodeIfPresent(profileId, forKey: .profileId)
    }

    /// The space's emoji, when its icon is one: as the Mac read it, or from `emoji:<char>` where a
    /// Phase 1 Mac sent only the icon.
    public var emoji: String? {
        if let sentEmoji, !sentEmoji.isEmpty { return sentEmoji }
        guard let icon = icon?.stringValue, icon.hasPrefix("emoji:") else { return nil }
        let char = String(icon.dropFirst("emoji:".count))
        return char.isEmpty ? nil : char
    }

    /// The icon is the person's own picture, which `space.icon` sends.
    public var hasPicture: Bool { iconKind == .picture }
}

/// A profile, as the desktop's sidebar switches between them: a set of spaces.
public struct Profile: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let icon: String
    public let color: String
    /// What `icon` is: a glyph, an emoji or a picture.
    public let iconKind: SpaceIconKind?
    public let glyph: String?
    public let emoji: String?
    /// How many sessions in its spaces Needs you lists.
    public let needsYou: Int

    public init(id: String, name: String, icon: String = "", color: String = "", iconKind: SpaceIconKind? = nil,
                glyph: String? = nil, emoji: String? = nil, needsYou: Int = 0) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.iconKind = iconKind
        self.glyph = glyph
        self.emoji = emoji
        self.needsYou = needsYou
    }

    private enum CodingKeys: String, CodingKey { case id, name, icon, color, iconKind, glyph, emoji, needsYou }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? ""
        color = (try? c.decodeIfPresent(String.self, forKey: .color)) ?? ""
        iconKind = try? c.decodeIfPresent(SpaceIconKind.self, forKey: .iconKind)
        glyph = try? c.decodeIfPresent(String.self, forKey: .glyph)
        emoji = try? c.decodeIfPresent(String.self, forKey: .emoji)
        needsYou = (try? c.decodeIfPresent(Int.self, forKey: .needsYou)) ?? 0
    }
}

/// `home.get`
public struct Home: Codable, Sendable, Hashable {
    public let mac: MacInfo
    public let needsYou: [SessionRow]
    public let spaces: [Space]
    /// Every profile, in the desktop's order; nil from a Mac before Plan 29.
    public let profiles: [Profile]?
    /// The profile `recent` was gathered for, or nil for every profile.
    public let profileId: String?
    /// The listed sessions active most recently in that profile, newest first; nil from an older Mac.
    public let recent: [SessionRow]?

    public init(mac: MacInfo, needsYou: [SessionRow], spaces: [Space], profiles: [Profile]? = nil, profileId: String? = nil,
                recent: [SessionRow]? = nil) {
        self.mac = mac
        self.needsYou = needsYou
        self.spaces = spaces
        self.profiles = profiles
        self.profileId = profileId
        self.recent = recent
    }
}

/// `space.sessions`: one page of a space's listed sessions, most recently active first.
public struct SpaceSessions: Codable, Sendable, Hashable {
    public let sessions: [SessionRow]
    /// More come after this page.
    public let more: Bool

    public init(sessions: [SessionRow], more: Bool) {
        self.sessions = sessions
        self.more = more
    }
}

/// One choice a picker offers: what is sent, and what is shown.
public struct Choice: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// A model an agent offers, as the desktop's picker names it. A nil `id` is the agent's own default.
public struct ModelChoice: Codable, Sendable, Hashable {
    public let id: String?
    public let label: String
    /// The reasoning levels this model takes, where it takes any.
    public let efforts: [Choice]?
    public let defaultEffort: String?

    public init(id: String?, label: String, efforts: [Choice]? = nil, defaultEffort: String? = nil) {
        self.id = id
        self.label = label
        self.efforts = efforts
        self.defaultEffort = defaultEffort
    }
}

/// What can be chosen for one agent: its models, reasoning levels, modes and permission rungs.
public struct AgentOptions: Codable, Sendable, Hashable {
    public let kind: String
    public let name: String
    /// Which mark the desktop draws for it, as `SessionRow.agentMark`.
    public let mark: String
    /// Installed and signed in, as far as the Mac's last look found; `note` says why not.
    public let available: Bool
    public let note: String?
    public let models: [ModelChoice]
    /// Reasoning levels that are the agent's own setting rather than a model's.
    public let efforts: [Choice]
    /// Which of those the agent runs while none is chosen, where it names one.
    public let defaultEffort: String?
    /// Build, then Plan and Ask where the agent has them.
    public let modes: [Choice]
    /// How freely the agent may act, least to most; empty where Realm cannot set it for this agent.
    public let permissions: [Choice]
    /// What Steer does to this agent's running turn, in words.
    public let steerNote: String

    public init(kind: String, name: String, mark: String, available: Bool = true, note: String? = nil, models: [ModelChoice],
                efforts: [Choice] = [], defaultEffort: String? = nil, modes: [Choice] = [], permissions: [Choice] = [], steerNote: String = "") {
        self.kind = kind
        self.name = name
        self.mark = mark
        self.available = available
        self.note = note
        self.models = models
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.modes = modes
        self.permissions = permissions
        self.steerNote = steerNote
    }
}

/// What the Mac takes with one message.
public struct SendLimits: Codable, Sendable, Hashable {
    public let maxCount: Int
    public let maxBytes: Int
    public let maxTotalBytes: Int

    public init(maxCount: Int, maxBytes: Int, maxTotalBytes: Int) {
        self.maxCount = maxCount
        self.maxBytes = maxBytes
        self.maxTotalBytes = maxTotalBytes
    }
}

/// `session.options` and `session.configure`: a session's settings as the composer shows them, and what
/// each could be changed to.
public struct SessionOptions: Codable, Sendable, Hashable {
    public let agent: AgentOptions
    public let model: String?
    /// The model it runs on now as the chip names it: its default's name while none is pinned.
    public let modelLabel: String
    public let effort: String?
    public let permissionMode: String?
    /// What a message typed while a turn runs does on this Mac, unless the phone says otherwise.
    public let midTurn: Delivery
    public let attachments: SendLimits

    public init(agent: AgentOptions, model: String?, modelLabel: String, effort: String?, permissionMode: String?,
                midTurn: Delivery, attachments: SendLimits) {
        self.agent = agent
        self.model = model
        self.modelLabel = modelLabel
        self.effort = effort
        self.permissionMode = permissionMode
        self.midTurn = midTurn
        self.attachments = attachments
    }

    /// The mode the session is in.
    public var mode: SessionMode { permissionMode.map(SessionMode.of) ?? .build }
}

/// `agents.list`: the agents a new session could be given, the one the Mac starts with, and what one
/// message takes.
public struct AgentList: Codable, Sendable, Hashable {
    public let agents: [AgentOptions]
    public let defaultAgent: String?
    public let midTurn: Delivery
    public let attachments: SendLimits

    public init(agents: [AgentOptions], defaultAgent: String?, midTurn: Delivery, attachments: SendLimits) {
        self.agents = agents
        self.defaultAgent = defaultAgent
        self.midTurn = midTurn
        self.attachments = attachments
    }
}

/// A file going to the Mac with a message, as `session.send` and `session.create` carry it.
public struct AttachmentUpload: Encodable, Sendable, Hashable {
    public let name: String
    public let mime: String
    /// The bytes, base64.
    public let data: String

    public init(name: String, mime: String, bytes: Data) {
        self.name = name
        self.mime = mime
        self.data = bytes.base64EncodedString()
    }
}

/// What `session.configure` changes. A field left nil stays as it is; `model: .some(nil)` puts the
/// agent's own default back.
public struct SessionChanges: Encodable, Sendable, Hashable {
    public var model: String??
    public var effort: String??
    public var mode: SessionMode?
    public var permission: String?

    public init(model: String?? = nil, effort: String?? = nil, mode: SessionMode? = nil, permission: String? = nil) {
        self.model = model
        self.effort = effort
        self.mode = mode
        self.permission = permission
    }

    private enum CodingKeys: String, CodingKey { case model, effort, mode, permission }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let model {
            if let model { try c.encode(model, forKey: .model) } else { try c.encodeNil(forKey: .model) }
        }
        if let effort {
            if let effort { try c.encode(effort, forKey: .effort) } else { try c.encodeNil(forKey: .effort) }
        }
        try c.encodeIfPresent(mode, forKey: .mode)
        try c.encodeIfPresent(permission, forKey: .permission)
    }
}

/// `session.open`
public struct OpenedSession: Codable, Sendable, Hashable {
    public let session: SessionRow
    public let rows: [TranscriptRow]
    public let hasMore: Bool
    /// The suggested next message (`prompt_hint`); nil when there is none, or from a Phase 1 Mac.
    public let hint: String?

    public init(session: SessionRow, rows: [TranscriptRow], hasMore: Bool, hint: String? = nil) {
        self.session = session
        self.rows = rows
        self.hasMore = hasMore
        self.hint = hint
    }
}

/// `session.changes`: the files one turn changed.
public struct TurnChanges: Codable, Sendable, Hashable {
    public let checkpointId: String
    public let files: [ChangedFile]
    /// How many it changed, which may be more than `files` lists.
    public let totalFiles: Int

    public init(checkpointId: String, files: [ChangedFile], totalFiles: Int) {
        self.checkpointId = checkpointId
        self.files = files
        self.totalFiles = totalFiles
    }
}

/// One file a turn changed, as git counted it. Lines are nil for a binary file.
public struct ChangedFile: Codable, Sendable, Hashable {
    public let path: String
    public let oldPath: String?
    /// "added", "modified", "deleted", "renamed" or "type-changed".
    public let status: String
    public let additions: Int?
    public let deletions: Int?

    public init(path: String, oldPath: String?, status: String, additions: Int?, deletions: Int?) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

/// `session.diff`: one page of a file's unified diff. `lines[i]` is line `from + i` of `total`; `next`
/// is the next page's `from`, nil on the last page.
public struct DiffPage: Codable, Sendable, Hashable {
    public let path: String
    public let oldPath: String?
    public let status: String
    public let binary: Bool
    public let additions: Int
    public let deletions: Int
    public let lines: [String]
    public let from: Int
    public let next: Int?
    public let total: Int
    /// The Mac stopped reading the patch at its own ceiling, `truncatedReason` says which.
    public let truncated: Bool
    public let truncatedReason: String?

    /// What a line of a unified diff is, by its first character.
    public enum LineKind: Sendable, Hashable {
        case fileHeader, hunkHeader, added, removed, context, note
    }

    public static func kind(of line: String) -> LineKind {
        if line.hasPrefix("+++ ") || line.hasPrefix("--- ") { return .fileHeader }
        if line.hasPrefix("@@") { return .hunkHeader }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        if line.hasPrefix("\\") { return .note }
        return .context
    }
}

/// `session.file`: what the phone may see of a file a turn made.
public struct FilePreview: Decodable, Sendable, Hashable {
    public enum Preview: Sendable, Hashable {
        /// A JPEG no larger than 1024 pixels on its longer side.
        case image(mime: String, data: Data)
        case text(String, truncated: Bool)
        /// Nothing to show here, and why.
        case none(reason: String)
        /// A preview this phone does not know.
        case unknown(kind: String)
    }

    public let path: String
    public let name: String
    public let size: Double
    public let mime: String
    public let preview: Preview

    private enum CodingKeys: String, CodingKey { case path, name, size, mime, preview }
    private enum PreviewKeys: String, CodingKey { case kind, mime, data, text, truncated, reason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        size = (try? c.decodeIfPresent(Double.self, forKey: .size)) ?? 0
        mime = (try? c.decodeIfPresent(String.self, forKey: .mime)) ?? ""
        let p = try c.nestedContainer(keyedBy: PreviewKeys.self, forKey: .preview)
        let kind = (try? p.decode(String.self, forKey: .kind)) ?? ""
        switch kind {
        case "image":
            guard let data = Data(base64Encoded: try p.decode(String.self, forKey: .data)) else {
                preview = .none(reason: "The picture did not arrive whole.")
                return
            }
            preview = .image(mime: (try? p.decode(String.self, forKey: .mime)) ?? "image/jpeg", data: data)
        case "text":
            preview = .text(try p.decode(String.self, forKey: .text), truncated: (try? p.decode(Bool.self, forKey: .truncated)) ?? false)
        case "none":
            preview = .none(reason: (try? p.decode(String.self, forKey: .reason)) ?? "")
        default:
            preview = .unknown(kind: kind)
        }
    }
}

/// `space.icon`: a space's own picture.
public struct SpacePicture: Decodable, Sendable, Hashable {
    public let mime: String
    public let data: Data

    private enum CodingKeys: String, CodingKey { case mime, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mime = try c.decode(String.self, forKey: .mime)
        guard let data = Data(base64Encoded: try c.decode(String.self, forKey: .data)) else {
            throw DecodingError.dataCorruptedError(forKey: .data, in: c, debugDescription: "not base64")
        }
        self.data = data
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

/// `session.hint`: the suggested next message changed, to a new one or to none.
public struct SessionHintEvent: Decodable, Sendable, Equatable {
    public let id: String
    public let text: String?

    public init(id: String, text: String?) {
        self.id = id
        self.text = text
    }
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
    case sessionHint(SessionHintEvent)
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

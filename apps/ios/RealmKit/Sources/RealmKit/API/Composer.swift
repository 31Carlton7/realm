import Foundation

/// One of the person's own `/` commands, from `<space>/commands`, `~/Realm/commands` or `~/.claude/commands`.
public struct UserCommand: Codable, Sendable, Hashable {
    public let name: String
    public let description: String
    /// What it takes after its name (`<file> [--fix]`): one that names none runs on nothing.
    public let argumentHint: String?

    public init(name: String, description: String, argumentHint: String?) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
    }
}

/// A skill the session's agent can be handed by `@id`.
public struct MentionSkill: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let description: String

    public init(id: String, name: String, description: String) {
        self.id = id
        self.name = name
        self.description = description
    }
}

/// What the composer's `/` and `@` offer that the phone does not already hold (`session.composer`).
public struct ComposerLists: Codable, Sendable, Hashable {
    public let commands: [UserCommand]
    public let skills: [MentionSkill]

    public init(commands: [UserCommand], skills: [MentionSkill]) {
        self.commands = commands
        self.skills = skills
    }
}

/// A file in the session's folder an `@` can name: `path` is where it is on the Mac, `rel` where it is
/// in the folder.
public struct MentionFile: Codable, Sendable, Hashable {
    public let path: String
    public let rel: String

    public init(path: String, rel: String) {
        self.path = path
        self.rel = rel
    }
}

/// A command filled in with its words: what the composer then holds. A `$2` the words did not reach
/// stays in `text`, and is named in `missing`.
public struct ExpandedCommand: Codable, Sendable, Hashable {
    public let text: String
    public let missing: [String]
}

/// What an `@[label]` in a message names, sent beside its words as the desktop's prompter sends it.
public enum MentionRef: Codable, Sendable, Hashable {
    /// A teammate, by its id: it is handed the message in its own chat.
    case role(label: String, roleId: String)
    /// A file in the session's folder, by where it is on the Mac.
    case file(label: String, path: String)

    public var label: String {
        switch self {
        case .role(let label, _), .file(let label, _): label
        }
    }

    private enum Key: String, CodingKey { case kind, label, roleId, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let label = try c.decode(String.self, forKey: .label)
        switch try c.decode(String.self, forKey: .kind) {
        case "role": self = .role(label: label, roleId: try c.decode(String.self, forKey: .roleId))
        case "file": self = .file(label: label, path: try c.decode(String.self, forKey: .path))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "no mention of kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .role(let label, let roleId):
            try c.encode("role", forKey: .kind)
            try c.encode(label, forKey: .label)
            try c.encode(roleId, forKey: .roleId)
        case .file(let label, let path):
            try c.encode("file", forKey: .kind)
            try c.encode(label, forKey: .label)
            try c.encode(path, forKey: .path)
        }
    }
}

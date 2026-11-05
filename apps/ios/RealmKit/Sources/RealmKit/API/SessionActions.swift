import Foundation

/// One login a session's agent can run on, as the desktop picker's Account list names it
/// (`session.accounts`).
public struct SessionAccount: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    /// The email the CLI says it is signed in as, or nil before it has said.
    public let email: String?
    /// The CLI's own folder, which the desktop calls "CLI sign-in" until it names an email.
    public let cliDefault: Bool
    /// False once the CLI says it is signed out; nil when it has not been asked.
    public let signedIn: Bool?

    public init(id: String, label: String, email: String?, cliDefault: Bool, signedIn: Bool?) {
        self.id = id
        self.label = label
        self.email = email
        self.cliDefault = cliDefault
        self.signedIn = signedIn
    }

    /// The line under its name, as the desktop's Account list has it.
    public var detail: String? {
        email ?? (cliDefault ? "CLI sign-in" : nil)
    }
}

/// The logins a session's agent can run on, and the one it runs on now.
public struct SessionAccounts: Codable, Sendable, Hashable {
    public let accounts: [SessionAccount]
    public let current: String?

    public init(accounts: [SessionAccount], current: String?) {
        self.accounts = accounts
        self.current = current
    }
}

/// A turn saved from a session, as the desktop's Library ▸ Saved lists it (`saved.list`).
public struct SavedTurn: Codable, Sendable, Hashable, Identifiable {
    public let sessionId: String
    /// The prompt's row's `seq`.
    public let seq: Int
    public let savedAt: Millis
    /// When the prompt was sent.
    public let at: Millis
    /// The prompt's words; empty for one that only carried files, which `attachments` names.
    public let text: String
    public let attachments: [String]
    /// The first stretch of its answer, or nil before anything answered it.
    public let reply: String?
    public let sessionTitle: String
    public let spaceId: String
    public let spaceName: String

    public var id: String { "\(sessionId)/\(seq)" }

    public init(sessionId: String, seq: Int, savedAt: Millis, at: Millis, text: String, attachments: [String], reply: String?,
                sessionTitle: String, spaceId: String, spaceName: String) {
        self.sessionId = sessionId
        self.seq = seq
        self.savedAt = savedAt
        self.at = at
        self.text = text
        self.attachments = attachments
        self.reply = reply
        self.sessionTitle = sessionTitle
        self.spaceId = spaceId
        self.spaceName = spaceName
    }
}

public struct SavedTurns: Codable, Sendable, Hashable {
    public let entries: [SavedTurn]
    public let total: Int

    public init(entries: [SavedTurn], total: Int) {
        self.entries = entries
        self.total = total
    }
}

/// `session.saved`: an open session's saved turns, the whole set.
public struct SessionSavedEvent: Decodable, Sendable, Equatable {
    public let id: String
    public let seqs: [Int]

    public init(id: String, seqs: [Int]) {
        self.id = id
        self.seqs = seqs
    }
}

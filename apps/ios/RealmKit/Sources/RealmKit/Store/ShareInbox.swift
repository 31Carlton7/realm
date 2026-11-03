import Foundation

/// Where a share from another app goes: an existing session, or a new one with an agent in a space.
public enum ShareTarget: Codable, Sendable, Hashable {
    case session(id: String)
    case newSession(agent: String, spaceId: String)
}

/// A file a share brought, copied into its folder in the inbox under the name the Mac will know it by.
public struct SharedFile: Codable, Sendable, Hashable {
    public let name: String

    public init(name: String) {
        self.name = name
    }

    /// The name a file goes by: the one the other app suggested, with the file's extension where it
    /// has none, else the type's; the file's own where none was suggested.
    public static func name(suggested: String?, file: URL, typeExtension: String?) -> String {
        guard let suggested, !suggested.isEmpty else { return file.lastPathComponent }
        let named = suggested.replacingOccurrences(of: "/", with: "-")
        if !(named as NSString).pathExtension.isEmpty { return named }
        let ext = file.pathExtension.isEmpty ? typeExtension : file.pathExtension
        return ext.map { "\(named).\($0)" } ?? named
    }
}

/// What a person shared into Realm from another app, waiting for the app to put it in a composer.
public struct SharedItem: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let target: ShareTarget
    /// The words that came with it: a link, a passage of text, or what the person typed.
    public let text: String
    public let files: [SharedFile]
    public let sharedAt: Date

    public init(id: UUID, target: ShareTarget, text: String, files: [SharedFile], sharedAt: Date) {
        self.id = id
        self.target = target
        self.text = text
        self.files = files
        self.sharedAt = sharedAt
    }
}

/// What the share extension offers: the sessions and spaces Home last showed and the agents a new
/// session could be given. The app writes it; the extension, which cannot reach the Mac, only reads it.
public struct ShareTargets: Codable, Sendable, Hashable {
    public let macName: String
    /// The sessions to offer, newest activity first.
    public let sessions: [SessionRow]
    public let spaces: [Space]
    public let agents: [AgentOptions]
    /// The space a new session goes in until another is picked.
    public let spaceId: String?

    public init(macName: String, sessions: [SessionRow], spaces: [Space], agents: [AgentOptions], spaceId: String?) {
        self.macName = macName
        self.sessions = sessions
        self.spaces = spaces
        self.agents = agents
        self.spaceId = spaceId
    }
}

/// The share extension's hand-off to the app, in the App Group's container both can open. Each share
/// is a folder: its files, copied in one at a time from the URLs the other app gave so a film is never
/// read into the extension's memory, and `share.json`, written last. A folder without one is a share
/// still being made, or one put away, and the app never takes it.
public struct ShareInbox: Sendable {
    public static let appGroup = "group.co.charmtechnologies.realm.ios"

    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The inbox in the App Group's container; nil where the app was built without the group.
    public static func shared() -> ShareInbox? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
            .map { ShareInbox(directory: $0.appending(path: "Shares", directoryHint: .isDirectory)) }
    }

    private var targetsFile: URL { directory.appending(path: "targets.json") }
    private func folder(_ id: UUID) -> URL { directory.appending(path: id.uuidString, directoryHint: .isDirectory) }
    private func manifest(_ id: UUID) -> URL { folder(id).appending(path: "share.json") }

    // MARK: - The extension's side

    /// Copies a file the other app handed over into a share's folder as `given`, numbered where the
    /// share already has a file by that name.
    public func copy(_ url: URL, named given: String, into id: UUID) throws -> SharedFile {
        let manager = FileManager.default
        try manager.createDirectory(at: folder(id), withIntermediateDirectories: true)
        var name = given
        var number = 2
        while manager.fileExists(atPath: folder(id).appending(path: name).path) {
            let stem = (given as NSString).deletingPathExtension, ext = (given as NSString).pathExtension
            name = ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)"
            number += 1
        }
        try manager.copyItem(at: url, to: folder(id).appending(path: name))
        return SharedFile(name: name)
    }

    /// Makes a share the app will take: its manifest, written once every file is in.
    public func commit(_ item: SharedItem) throws {
        try FileManager.default.createDirectory(at: folder(item.id), withIntermediateDirectories: true)
        try JSONEncoder().encode(item).write(to: manifest(item.id), options: RealmCache.writingOptions)
    }

    /// A share, and whatever it copied: one taken, or one put away before it was made.
    public func remove(_ id: UUID) {
        try? FileManager.default.removeItem(at: folder(id))
    }

    public func loadTargets() -> ShareTargets? {
        guard let data = try? Data(contentsOf: targetsFile) else { return nil }
        return try? JSONDecoder().decode(ShareTargets.self, from: data)
    }

    // MARK: - The app's side

    /// The shares made and not yet taken, oldest first.
    public func pending() -> [SharedItem] {
        guard let folders = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return [] }
        return folders.compactMap { folder in
            guard let data = try? Data(contentsOf: folder.appending(path: "share.json")) else { return nil }
            return try? JSONDecoder().decode(SharedItem.self, from: data)
        }
        .sorted { $0.sharedAt < $1.sharedAt }
    }

    public func url(of file: SharedFile, in item: SharedItem) -> URL {
        folder(item.id).appending(path: file.name)
    }

    /// Folders the extension began and never committed, from a share it was closed in the middle of:
    /// gone once they are older than `age`.
    public func removeAbandoned(olderThan age: TimeInterval, now: Date = Date()) {
        let manager = FileManager.default
        guard let folders = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey]) else { return }
        for folder in folders where folder.hasDirectoryPath && !manager.fileExists(atPath: folder.appending(path: "share.json").path) {
            let made = (try? folder.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
            if now.timeIntervalSince(made) > age { try? manager.removeItem(at: folder) }
        }
    }

    public func saveTargets(_ targets: ShareTargets) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(targets).write(to: targetsFile, options: RealmCache.writingOptions)
    }

    /// Everything, for a phone that forgets its Mac: no share or session of that Mac's is offered again.
    public func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}

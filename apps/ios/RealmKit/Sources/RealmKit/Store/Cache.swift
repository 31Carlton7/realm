import Foundation

/// A value read from the cache, and when it was last fresh from the Mac.
public struct Cached<Value: Sendable>: Sendable {
    public let value: Value
    public let savedAt: Date

    public init(value: Value, savedAt: Date) {
        self.value = value
        self.savedAt = savedAt
    }
}

/// One session as it was last seen: enough to draw it the moment it opens.
public struct TranscriptSnapshot: Codable, Sendable, Equatable {
    public let session: SessionRow?
    public let status: SessionStatus?
    public let rows: [TranscriptRow]
    public let hasMore: Bool

    public init(session: SessionRow?, status: SessionStatus?, rows: [TranscriptRow], hasMore: Bool) {
        self.session = session
        self.status = status
        self.rows = rows
        self.hasMore = hasMore
    }

    public init(_ transcript: Transcript) {
        self.init(session: transcript.session, status: transcript.status, rows: transcript.rows, hasMore: transcript.hasMore)
    }
}

/// What the app keeps on disk to have something to show the moment it opens: the last Home, the
/// sessions opened lately, and what is waiting to be sent. One directory per Mac, so a phone paired
/// again elsewhere never shows the last Mac's sessions.
///
/// Every file is written with complete protection, so none of it can be read while the phone is
/// locked. It is a cache: anything that does not read back is treated as absent.
public struct RealmCache: Sendable {
    public static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    /// How many sessions' rows are kept; the oldest written goes first.
    public static let transcriptLimit = 20

    public let directory: URL

    public init(root: URL, macId: String) {
        directory = root.appending(path: Self.fileName(macId), directoryHint: .isDirectory)
    }

    /// `Library/Caches/Realm`: not backed up, and the system may clear it, which costs nothing but a
    /// slower first screen.
    public static func defaultRoot() -> URL {
        URL.cachesDirectory.appending(path: "Realm", directoryHint: .isDirectory)
    }

    private var homeFile: URL { directory.appending(path: "home.json") }
    private var outboxFile: URL { directory.appending(path: "outbox.json") }
    private var sessions: URL { directory.appending(path: "sessions", directoryHint: .isDirectory) }

    private func sessionFile(_ id: String) -> URL { sessions.appending(path: "\(Self.fileName(id)).json") }

    private struct Envelope<Value: Codable>: Codable {
        let savedAt: Date
        let value: Value
    }

    // MARK: - Home

    public func saveHome(_ home: Home, at date: Date = Date()) throws {
        try write(Envelope(savedAt: date, value: home), to: homeFile)
    }

    public func loadHome() -> Cached<Home>? {
        read(Home.self, from: homeFile)
    }

    // MARK: - Sessions

    public func saveTranscript(_ snapshot: TranscriptSnapshot, id: String, at date: Date = Date()) throws {
        try write(Envelope(savedAt: date, value: snapshot), to: sessionFile(id))
        try trimTranscripts()
    }

    public func loadTranscript(_ id: String) -> Cached<TranscriptSnapshot>? {
        read(TranscriptSnapshot.self, from: sessionFile(id))
    }

    // MARK: - What waits to be sent

    public func saveOutbox(_ items: [OutgoingItem]) throws {
        if items.isEmpty {
            try? FileManager.default.removeItem(at: outboxFile)
            return
        }
        try write(Envelope(savedAt: Date(), value: items), to: outboxFile)
    }

    public func loadOutbox() -> [OutgoingItem] {
        read([OutgoingItem].self, from: outboxFile)?.value ?? []
    }

    /// Everything kept for this Mac.
    public func removeAll() throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.removeItem(at: directory)
    }

    // MARK: - Files

    private func write<Value: Codable>(_ envelope: Envelope<Value>, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(envelope).write(to: url, options: Self.writingOptions)
    }

    private func read<Value: Codable & Sendable>(_ type: Value.Type, from url: URL) -> Cached<Value>? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: data) else { return nil }
        return Cached(value: envelope.value, savedAt: envelope.savedAt)
    }

    private func trimTranscripts() throws {
        let files = try FileManager.default.contentsOfDirectory(at: sessions, includingPropertiesForKeys: [.contentModificationDateKey])
        guard files.count > Self.transcriptLimit else { return }
        let dated = files.map { url in
            (url, (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }
        for (url, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(Self.transcriptLimit) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// A name that is safe as a file name whatever the id holds: its own characters when they are
    /// plain, base64url of its bytes otherwise.
    static func fileName(_ id: String) -> String {
        let plain = !id.isEmpty && id.count <= 80
            && id.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_") }
        return plain ? id : "b64-" + Base64URL.encode(Data(id.utf8))
    }
}

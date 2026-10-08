import Foundation
@testable import RealmKit
import Testing

@Suite("The cache on disk")
struct CacheTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "realm-cache-\(UUID().uuidString)", directoryHint: .isDirectory)

    static func home() throws -> Home {
        try ModelTests.decode(Home.self, #"""
        {"mac":{"name":"MacBook Pro"},"needsYou":[\#(ModelTests.sessionRow)],
         "spaces":[{"id":"sp1","name":"Realm","icon":"emoji:🌊","color":"#3366ff","sessions":[\#(ModelTests.sessionRow)],"more":3}]}
        """#)
    }

    static func protection(_ url: URL) throws -> URLFileProtection? {
        try url.resourceValues(forKeys: [.fileProtectionKey]).fileProtection
    }

    @Test func homeAndRowsComeBackAsTheyWent() throws {
        let cache = RealmCache(root: root, macId: "mac-1")
        let home = try Self.home()
        let saved = Date(timeIntervalSince1970: 1_790_000_000)
        try cache.saveHome(home, at: saved)
        let restored = try #require(cache.loadHome())
        #expect(restored.value == home)
        #expect(restored.savedAt == saved)

        let opened = try ModelTests.decode(OpenedSession.self, ModelTests.everyKind)
        let snapshot = TranscriptSnapshot(session: opened.session, status: .running, rows: opened.rows, hasMore: true)
        try cache.saveTranscript(snapshot, id: "s1", at: saved)
        let back = try #require(cache.loadTranscript("s1"))
        #expect(back.value == snapshot)
        #expect(back.value.rows.map(\.content) == opened.rows.map(\.content))
        #expect(cache.loadTranscript("never-opened") == nil)
    }

    /// The cache holds transcripts: it must be unreadable while the phone is locked.
    @Test func everyFileIsWrittenWithCompleteProtection() throws {
        let cache = RealmCache(root: root, macId: "mac-1")
        try cache.saveHome(try Self.home())
        try cache.saveTranscript(TranscriptSnapshot(session: nil, status: nil, rows: [StoreTests.row("m:1", "hi")], hasMore: false), id: "s1")
        try cache.saveOutbox([OutgoingItem(sessionId: "s1", payload: .message(text: "Run the tests"), afterSeq: 3)])
        let files = [
            cache.directory.appending(path: "home.json"),
            cache.directory.appending(path: "sessions/s1.json"),
            cache.directory.appending(path: "outbox.json"),
        ]
        for file in files {
            #expect(FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent) was written")
            #expect(try Self.protection(file) == .complete, "\(file.lastPathComponent) is readable while the phone is locked")
        }
        #expect(RealmCache.writingOptions.contains(.completeFileProtection))
    }

    @Test func eachMacHasItsOwnCache() throws {
        try RealmCache(root: root, macId: "mac-1").saveHome(try Self.home())
        #expect(RealmCache(root: root, macId: "mac-2").loadHome() == nil)
        let first = RealmCache(root: root, macId: "mac-1")
        #expect(first.loadHome() != nil)
        try first.removeAll()
        #expect(first.loadHome() == nil)
        try first.removeAll()
    }

    @Test func onlyTheMostRecentSessionsAreKept() throws {
        let cache = RealmCache(root: root, macId: "mac-1")
        let snapshot = TranscriptSnapshot(session: nil, status: nil, rows: [], hasMore: false)
        for index in 0..<(RealmCache.transcriptLimit + 3) {
            try cache.saveTranscript(snapshot, id: "s\(index)")
            // Modification dates are what ages them; keep them apart.
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(1_000 + index))],
                                                  ofItemAtPath: cache.directory.appending(path: "sessions/s\(index).json").path)
        }
        try cache.saveTranscript(snapshot, id: "latest")
        let kept = try FileManager.default.contentsOfDirectory(atPath: cache.directory.appending(path: "sessions").path)
        #expect(kept.count == RealmCache.transcriptLimit)
        #expect(kept.contains("latest.json"))
        #expect(!kept.contains("s0.json"))
    }

    @Test func aFileThatDoesNotReadBackIsAbsent() throws {
        let cache = RealmCache(root: root, macId: "mac-1")
        try cache.saveHome(try Self.home())
        try Data("not json".utf8).write(to: cache.directory.appending(path: "home.json"))
        #expect(cache.loadHome() == nil)
        #expect(cache.loadOutbox().isEmpty)
    }

    @Test func idsAreSafeFileNames() {
        #expect(RealmCache.fileName("s_1-AB") == "s_1-AB")
        #expect(RealmCache.fileName("../../etc").hasPrefix("b64-"))
        #expect(!RealmCache.fileName("a/b").contains("/"))
        #expect(RealmCache.fileName("") == "b64-")
    }

    @Test func whatWaitsToBeSentSurvivesARelaunch() throws {
        let cache = RealmCache(root: root, macId: "mac-1")
        let items = [
            OutgoingItem(sessionId: "s1", payload: .message(text: "one"), state: .sending, afterSeq: 1),
            OutgoingItem(sessionId: "s1", payload: .answer(requestId: "r1", decision: .deny, answers: nil), state: .delivered, afterSeq: 1),
            OutgoingItem(sessionId: "s1", payload: .answer(requestId: "r2", decision: .allow, answers: ["Which?": "A"]), afterSeq: 2),
            OutgoingItem(sessionId: "s2", payload: .message(text: "two"), state: .failed("Session ended"), afterSeq: 9),
        ]
        try cache.saveOutbox(items)
        let saved = cache.loadOutbox()
        #expect(saved == items)
        let restored = Outbox.restored(saved)
        // On its way when the app went: it may have arrived, so it is looked for before going again.
        #expect(restored.items.map(\.state) == [.unconfirmed, .waiting, .failed("Session ended")])
        try cache.saveOutbox([])
        #expect(cache.loadOutbox().isEmpty)
    }
}

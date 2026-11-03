import Foundation
@testable import RealmKit
import Testing

/// A share from another app, handed from the extension to the app: copied in file by file, taken only
/// once it is whole, and its files moved into a composer without being read.
struct ShareInboxTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "realm-share-\(UUID().uuidString)", directoryHint: .isDirectory)

    var inbox: ShareInbox { ShareInbox(directory: root.appending(path: "Shares", directoryHint: .isDirectory)) }

    /// A file as the other app hands it over: somewhere of its own, under its own name.
    func given(_ name: String, _ bytes: Data) throws -> URL {
        let folder = root.appending(path: "given-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: name)
        try bytes.write(to: url)
        return url
    }

    @Test func aShareIsTakenOnlyOnceItIsCommitted() throws {
        let id = UUID()
        let clip = try inbox.copy(given("IMG_0001.MOV", Data(count: 4_096)), named: "IMG_0001.MOV", into: id)
        #expect(inbox.pending().isEmpty)
        let item = SharedItem(id: id, target: .session(id: "s1"), text: "The sidebar, collapsing", files: [clip], sharedAt: Date())
        try inbox.commit(item)
        #expect(inbox.pending() == [item])
        #expect(try Data(contentsOf: inbox.url(of: clip, in: item)) == Data(count: 4_096))
    }

    @Test func twoFilesOfOneNameAreKeptApart() throws {
        let id = UUID()
        let first = try inbox.copy(given("photo.jpg", Data([1])), named: "photo.jpg", into: id)
        let second = try inbox.copy(given("photo.jpg", Data([2])), named: "photo.jpg", into: id)
        let third = try inbox.copy(given("notes", Data([3])), named: "notes", into: id)
        let fourth = try inbox.copy(given("notes", Data([4])), named: "notes", into: id)
        #expect([first, second, third, fourth].map(\.name) == ["photo.jpg", "photo 2.jpg", "notes", "notes 2"])
    }

    @Test func aSharedFileIsNamedAsTheOtherAppNamedIt() {
        let temporary = URL(fileURLWithPath: "/tmp/3F2A/IMG_0412.HEIC")
        #expect(SharedFile.name(suggested: "IMG_0412", file: temporary, typeExtension: "heic") == "IMG_0412.HEIC")
        #expect(SharedFile.name(suggested: "Q3 deck.pdf", file: temporary, typeExtension: "pdf") == "Q3 deck.pdf")
        #expect(SharedFile.name(suggested: "Notes", file: URL(fileURLWithPath: "/tmp/3F2A/data"), typeExtension: "txt") == "Notes.txt")
        #expect(SharedFile.name(suggested: "a/b", file: URL(fileURLWithPath: "/tmp/x"), typeExtension: nil) == "a-b")
        #expect(SharedFile.name(suggested: nil, file: temporary, typeExtension: "heic") == "IMG_0412.HEIC")
    }

    @Test func sharesComeOldestFirstAndGoWhenTaken() throws {
        let later = SharedItem(id: UUID(), target: .newSession(agent: "claude", spaceId: "sp1"), text: "b", files: [], sharedAt: Date(timeIntervalSince1970: 200))
        let earlier = SharedItem(id: UUID(), target: .session(id: "s1"), text: "a", files: [], sharedAt: Date(timeIntervalSince1970: 100))
        try inbox.commit(later)
        try inbox.commit(earlier)
        #expect(inbox.pending() == [earlier, later])
        inbox.remove(earlier.id)
        #expect(inbox.pending() == [later])
    }

    @Test func aSharePutAwayLeavesNothing() throws {
        let id = UUID()
        _ = try inbox.copy(given("deck.pdf", Data("%PDF".utf8)), named: "deck.pdf", into: id)
        inbox.remove(id)
        #expect(!FileManager.default.fileExists(atPath: inbox.directory.appending(path: id.uuidString).path))
    }

    @Test func onlyAnAbandonedShareIsClearedAway() throws {
        let abandoned = UUID()
        _ = try inbox.copy(given("clip.mov", Data(count: 10)), named: "clip.mov", into: abandoned)
        let made = SharedItem(id: UUID(), target: .session(id: "s1"), text: "", files: [], sharedAt: Date())
        try inbox.commit(made)
        inbox.removeAbandoned(olderThan: 3_600)
        #expect(FileManager.default.fileExists(atPath: inbox.directory.appending(path: abandoned.uuidString).path))
        inbox.removeAbandoned(olderThan: 3_600, now: Date().addingTimeInterval(7_200))
        #expect(!FileManager.default.fileExists(atPath: inbox.directory.appending(path: abandoned.uuidString).path))
        #expect(inbox.pending() == [made])
    }

    @Test func theTargetsReadBackAsTheAppWroteThem() throws {
        #expect(inbox.loadTargets() == nil)
        let agent = AgentOptions(kind: "claude", name: "Claude", mark: "claude", models: [ModelChoice(id: nil, label: "Default")])
        let space = Space(id: "sp1", name: "Realm", icon: nil, color: nil, sessions: [], more: 0)
        let targets = ShareTargets(macName: "MacBook Pro", sessions: [StoreTests.session("s1")], spaces: [space], agents: [agent], spaceId: "sp1")
        try inbox.saveTargets(targets)
        #expect(inbox.loadTargets() == targets)
    }

    @Test func aSharedFileIsMovedIntoTheOutboxNotCopied() throws {
        let files = OutboxFiles(directory: root.appending(path: "Outbox", directoryHint: .isDirectory))
        let clip = try given("IMG_0001.MOV", Data(count: 8_192))
        let kept = try files.keep(movingFileAt: clip, name: "IMG_0001.MOV", mime: "video/quicktime")
        #expect(kept.size == 8_192)
        #expect(kept.file.hasSuffix(".mov"))
        #expect(try files.bytes(of: kept) == Data(count: 8_192))
        #expect(!FileManager.default.fileExists(atPath: clip.path))
    }
}

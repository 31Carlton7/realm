import Foundation
import RealmKit
import Testing
@testable import Realm

/// The phone's Memory: places keep the desktop's grouping in Home's order, a search answers once per file,
/// and a memory's lines and links say what the desktop's do.
struct MemoryTests {
    private static func row(_ title: String, description: String? = "About it", source: String = "Memory repo", folder: String? = nil, index: Bool = false, match: String? = nil) -> MemoryRow {
        MemoryRow(id: "\(source):\(title)", title: title, description: description, type: nil, source: source, folder: folder, index: index, updatedAt: 1, match: match)
    }

    private static func place(_ id: String, _ kind: MemoryPlace.Kind, title: String, profile: String = "p1", spaceId: String? = nil) -> MemoryPlace {
        MemoryPlace(id: id, profileId: profile, kind: kind, spaceId: spaceId, title: title, count: 1, entries: [row(title)])
    }

    private static func memory(_ profile: String, _ places: [MemoryPlace]) -> ProfileMemory {
        ProfileMemory(profileId: profile, overview: MemoryOverview(places: places, homes: [], learning: true))
    }

    @Test func placesListEverySpaceThenSpacesInHomesOrderThenAgents() {
        let places = MemorySections.arranged([Self.memory("p1", [
            Self.place("agent:claude", .agent, title: "Claude"),
            Self.place("space:b", .space, title: "B", spaceId: "b"),
            Self.place("every:p1", .every, title: "Every space"),
            Self.place("space:a", .space, title: "A", spaceId: "a"),
        ])], spaceOrder: ["a", "b"], profileNames: ["p1": "Work"])
        #expect(places.map(\.id) == ["every:p1", "space:a", "space:b", "agent:claude"])
        #expect(places[0].title == "Every space")
    }

    @Test func everyProfileKeepsItsOwnPlacesAndSharesItsAgentsOnce() {
        let places = MemorySections.arranged([
            Self.memory("p1", [Self.place("every:p1", .every, title: "Every space"), Self.place("agent:claude", .agent, title: "Claude")]),
            Self.memory("p2", [Self.place("every:p2", .every, title: "Every space", profile: "p2"), Self.place("agent:claude", .agent, title: "Claude", profile: "p2")]),
        ], spaceOrder: [], profileNames: ["p1": "Work", "p2": "Home"])
        #expect(places.map(\.id) == ["every:p1", "every:p2", "agent:claude"])
        #expect(places.map(\.title) == ["Work · every space", "Home · every space", "Claude"])
    }

    @Test func aSearchAcrossProfilesAnswersOncePerFileInTheirOrder() {
        let shared = Self.row("House rules", source: "Claude · User memory")
        let hits = MemoryHit.merged([
            ("p1", MemoryPage(entries: [Self.row("Best"), shared], total: 2, next: nil)),
            ("p2", MemoryPage(entries: [shared, Self.row("Other")], total: 2, next: nil)),
        ])
        #expect(hits.map(\.row.title) == ["Best", "House rules", "Other"])
        #expect(hits.map(\.profileId) == ["p1", "p1", "p2"])
    }

    @Test func aMemoryMovedBetweenPagesIsListedOnce() {
        var pages = MemoryPages()
        pages.start(MemoryPage(entries: [Self.row("a"), Self.row("b")], total: 3, next: 2))
        #expect(pages.loaded && pages.next == 2)
        pages.append(MemoryPage(entries: [Self.row("b"), Self.row("c")], total: 3, next: nil))
        #expect(pages.rows.map(\.title) == ["a", "b", "c"])
        #expect(pages.next == nil)
    }

    @Test func aRowsLineIsASearchsBestLineOnlyWhereItSaysMore() {
        #expect(MemoryWords.line(Self.row("a", description: "Plain", match: "A better line")) == "A better line")
        #expect(MemoryWords.line(Self.row("a", description: "Same", match: "Same")) == "Same")
        #expect(MemoryWords.line(Self.row("Named", description: "About", match: "Named")) == "About")
        #expect(MemoryWords.line(Self.row("a", description: nil)) == nil)
    }

    @Test func aRowSaysWhereItIsKeptOnlyWhereItsHeadDoesNot() {
        let inRepo = Self.row("a", folder: "Realm")
        #expect(MemoryWords.place(inRepo, under: "Realm").isEmpty)
        #expect(MemoryWords.place(inRepo, under: "Every space") == "Realm")
        #expect(MemoryWords.place(inRepo) == "Memory repo · Realm")
        #expect(MemoryWords.place(Self.row("a", source: "Claude · Realm"), under: "Realm") == "Claude")
        #expect(MemoryWords.place(Self.row("a", source: "Claude · Project memory", folder: "atlas"), under: "Claude") == "Project memory · atlas")
        #expect(MemoryWords.place(Self.row("Index", folder: "Realm", index: true)) == "Memory repo")
    }

    @Test func deletingAndWritingUseTheDesktopsWords() {
        #expect(MemoryWords.deleted("a.md", trashed: false) == "Removed a.md from the memory repo.")
        #expect(MemoryWords.deleted("a.md", trashed: true) == "a.md is in the Trash.")
        #expect(MemoryWords.deleteMessage(external: true).contains("Trash"))
        #expect(MemoryWords.deleteMessage(external: false).contains("MEMORY.md"))
        #expect(MemoryWords.outsideQuestion(name: "CLAUDE.md", source: "Claude · User memory") == "CLAUDE.md is Claude's own file, outside Realm. Write your change into it?")
        #expect(MemoryWords.outsideQuestion(name: "x.md", source: "Odd") == "x.md is an agent's own file, outside Realm. Write your change into it?")
    }

    @Test func theReaderDoesNotSayTwiceWhatItsHeadSays() {
        #expect(MemoryWords.withoutTitle("# House rules\n\nSpeak plainly.\n", title: "House rules") == "Speak plainly.\n")
        #expect(MemoryWords.withoutTitle("\n## House rules\nSpeak.", title: "House rules") == "Speak.")
        #expect(MemoryWords.withoutTitle("# Other\n\nSpeak.", title: "House rules") == "# Other\n\nSpeak.")
        #expect(MemoryWords.withoutTitle("#House rules\nSpeak.", title: "House rules") == "#House rules\nSpeak.")
        let shown = MemoryWords.properties([.init(key: "name", value: "n"), .init(key: "metadata.type", value: "t"), .init(key: "metadata.owner", value: "me"), .init(key: "when", value: "now")])
        #expect(shown == [.init(key: "owner", value: "me"), .init(key: "when", value: "now")])
    }

    @Test func linksBetweenMemoriesComeBackOutOfTheRenderersWebLinks() throws {
        let links = [MemoryFile.Link(target: "uses pnpm", id: "repo:uses-pnpm.md"), MemoryFile.Link(target: "other.md", id: nil)]
        let drawn = MemoryLinks.linked("See [[uses pnpm]] and [the other](other.md), [a site](https://example.com).\n```\n[[uses pnpm]]\n```", links: links)
        let lines = drawn.components(separatedBy: "\n")
        #expect(lines[0].contains("[uses pnpm](https://memory.realm.invalid/?target=uses%20pnpm)"))
        #expect(lines[0].contains("[the other](https://memory.realm.invalid/?target=other.md)"))
        #expect(lines[0].contains("[a site](https://example.com)"))
        #expect(lines[2] == "[[uses pnpm]]")
        let address = try #require(URL(string: "https://memory.realm.invalid/?target=uses%20pnpm"))
        #expect(MemoryLinks.target(of: address) == "uses pnpm")
        #expect(MemoryLinks.target(of: try #require(URL(string: "https://example.com/?target=x"))) == nil)
    }
}

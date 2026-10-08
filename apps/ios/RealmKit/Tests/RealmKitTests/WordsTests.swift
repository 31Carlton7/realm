import Foundation
@testable import RealmKit
import Testing

@Suite("Words on a session's row")
struct WordsTests {
    static let now = LinkStatusTests.now
    static func millis(_ secondsAgo: TimeInterval) -> Millis { (now.timeIntervalSince1970 - secondsAgo) * 1000 }
    static func ago(_ secondsAgo: TimeInterval) -> String {
        Ago.text(millis(secondsAgo), now: now, calendar: LinkStatusTests.calendar, locale: Locale(identifier: "en_US"))
    }

    @Test func howLongAgoItMoved() {
        #expect(Self.ago(5) == "just now")
        #expect(Self.ago(-30) == "just now", "a Mac clock a little ahead is not the future")
        #expect(Self.ago(4 * 60 + 10) == "4m ago")
        #expect(Self.ago(2 * 3600 + 5) == "2h ago")
        #expect(Self.ago(3 * 86400) == "3d ago")
        #expect(Self.ago(9 * 86400) == "Sep 28")
        #expect(Self.ago(400 * 86400).hasSuffix("2025"))
    }

    @Test func everyStatusHasAWordAndASymbol() {
        for status in [SessionStatus.idle, .running, .waiting, .error, .ended, .other("paused")] {
            #expect(!status.word.isEmpty)
            #expect(!status.symbol.isEmpty)
        }
        #expect(SessionStatus.waiting.word == "Waiting on you")
        #expect(SessionStatus.error.word == "Failed")
    }

    @Test func agentsAreNamedAsTheDesktopNamesThem() throws {
        let presets = try String(contentsOf: Fixtures.repoRoot.appending(path: "packages/contracts/src/presets.ts"), encoding: .utf8)
        let block = try #require(presets.range(of: "export const AGENT_META = {").map { presets[$0.upperBound...] })
        let table = String(block[..<(block.range(of: "} as const")?.lowerBound ?? block.endIndex)])
        let pattern = /(?:"([\w:]+)"|([\w]+)):\s*\{\s*label:\s*"([^"]+)"/
        var desktop: [String: String] = [:]
        for match in table.matches(of: pattern) {
            let kind = String(match.output.1 ?? match.output.2 ?? "")
            desktop[kind] = String(match.output.3)
        }
        #expect(desktop.count >= 10, "the AGENT_META table was not found in presets.ts")
        #expect(desktop == AgentNames.labels, "AgentNames.labels has drifted from AGENT_META in presets.ts")
        #expect(AgentNames.label("acp:newcomer") == "Newcomer")
    }

    @Test func aSpaceShowsItsEmoji() throws {
        let spaces = try ModelTests.decode([Space].self, #"""
        [{"id":"a","name":"A","icon":"emoji:🌊","color":"#000000"},{"id":"b","name":"B","icon":"folder","color":"#000000"},
         {"id":"c","name":"C","icon":"emoji:","color":"#000000"},{"id":"d","name":"D","icon":"asset:x1","color":"#000000"}]
        """#)
        #expect(spaces.map(\.emoji) == ["🌊", nil, nil, nil])
    }
}

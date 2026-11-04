import Foundation
import RealmKit
import SwiftUI
import Testing
@testable import Realm

@Suite("Search and find")
@MainActor
struct SearchViewTests {
    static func said(_ seq: Int, _ text: String) -> TranscriptRow {
        TranscriptRow(key: "u:\(seq)", seq: seq, content: .user(text: text))
    }

    static func answer(_ key: String, seq: Int, _ text: String) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .assistant(text: text, streaming: false))
    }

    static func tool(_ key: String, seq: Int) -> TranscriptRow {
        TranscriptRow(key: key, seq: seq, content: .tool(name: "Bash", summary: "ls", state: .done, detail: nil))
    }

    @Test func marksOnlyWhatMatchedAndRunsTheLinesTogether() {
        let runs = [SnippetRun(text: "move the\n", match: false), SnippetRun(text: "pelican", match: true), SnippetRun(text: " north", match: false)]
        let text = Snippet.marked(runs, ink: .red)
        #expect(String(text.characters) == "move the pelican north")
        let marked = text.runs.filter { $0.backgroundColor != nil }.map { String(text[$0.range].characters) }
        #expect(marked == ["pelican"])
        #expect(text.runs.allSatisfy { $0.backgroundColor == nil || $0.backgroundColor == FindMark.tint(current: false) })
        #expect(Snippet.plain(runs) == "move the pelican north")
    }

    @Test func findsTheItemAFoldedMatchIsDrawnIn() {
        // A finished turn: what was said, an answer on the way and a tool call fold, the last answer stands.
        let rows = [Self.said(1, "move the pelican"), Self.answer("m:a", seq: 2, "looking for the pelican"), Self.tool("t:1", seq: 3),
                    Self.answer("m:b", seq: 4, "moved it")]
        let items = TranscriptLayout.items(rows, settled: true)
        #expect(TranscriptLayout.itemId(holding: "u:1", in: items) == "u:1")
        #expect(TranscriptLayout.itemId(holding: "m:a", in: items) == "fold/m:a")
        #expect(TranscriptLayout.itemId(holding: "m:b", in: items) == "m:b")
        #expect(TranscriptLayout.itemId(holding: "gone", in: items) == nil)
    }

    @Test func stepsThroughMatchesFromTheNewest() {
        let keys = ["u:1", "m:3", "u:5"]
        let start = FindPlace(keys: keys, current: nil, macHasEarlier: false)
        #expect(start.step(older: true) == "u:5")
        let newest = FindPlace(keys: keys, current: "u:5", macHasEarlier: false)
        #expect(newest.words == "3 of 3")
        #expect(newest.step(older: true) == "m:3")
        #expect(newest.step(older: false) == nil)
        #expect(!newest.hasNewer)
        let oldest = FindPlace(keys: keys, current: "u:1", macHasEarlier: false)
        #expect(oldest.step(older: true) == nil)
        #expect(!oldest.hasOlder)
        #expect(oldest.hasNewer)
    }

    @Test func goesToTheMacBeforeTheOldestMatchHereWhereItHasEarlierRows() {
        let oldest = FindPlace(keys: ["u:1", "u:5"], current: "u:1", macHasEarlier: true)
        #expect(oldest.hasOlder)
        #expect(oldest.olderIsOnMac)
        #expect(oldest.step(older: true) == nil)
        #expect(!FindPlace(keys: ["u:1", "u:5"], current: "u:5", macHasEarlier: true).olderIsOnMac)
        let none = FindPlace(keys: [], current: nil, macHasEarlier: true)
        #expect(none.words == "None here")
        #expect(none.hasOlder)
        #expect(FindPlace(keys: [], current: nil, macHasEarlier: false).words == "No matches")
        let asking = FindPlace(keys: ["u:1"], current: "u:1", macHasEarlier: true, asking: true)
        #expect(!asking.hasOlder)
        #expect(asking.words == "Searching…")
    }

    @Test func aFindHidesTheComposerUntilDoneAndThenForgetsItsWords() {
        var find = FindState()
        #expect(find.showsComposer)
        find.open()
        #expect(!find.showsComposer)
        find.query = "pelican"
        find.typed(matching: ["u:1", "m:3", "u:5"])
        #expect(find.current == "u:5")
        find.asking = true
        find.close()
        #expect(find.showsComposer)
        #expect(find == FindState())
    }

    @Test func stepsUpFromTheNewestToTheOldestAndBackDown() {
        let keys = ["u:1", "m:3", "u:5"]
        var find = FindState()
        find.open()
        find.typed(matching: keys)
        var visited = [find.current]
        while let next = FindPlace(keys: keys, current: find.current, macHasEarlier: false).step(older: true) {
            find.current = next
            visited.append(next)
        }
        #expect(visited == ["u:5", "m:3", "u:1"])
        #expect(FindPlace(keys: keys, current: find.current, macHasEarlier: false).words == "1 of 3")
        #expect(FindPlace(keys: keys, current: find.current, macHasEarlier: false).step(older: false) == "m:3")
    }

    static func tinted(_ text: AttributedString) -> [String] {
        text.runs.filter { $0.backgroundColor != nil }.map { String(text[$0.range].characters) }
    }

    @Test func marksEveryPlaceTheWordsAppearAndNothingElse() {
        let text = AttributedString("Aurora tonight; the aurora watch, AURORA again")
        let mark = FindMark.find(" aurora ", current: false)
        #expect(Self.tinted(mark.marked(text)) == ["Aurora", "aurora", "AURORA"])
        #expect(Self.tinted(FindMark.find("café", current: false).marked(AttributedString("a cafe here"))) == ["cafe"])
        #expect(Self.tinted(FindMark.find("  ", current: false).marked(text)).isEmpty)
        // A find matches its words as one run; a search's are each marked, as the Mac's index matched them.
        #expect(Self.tinted(FindMark.find("aurora watch", current: false).marked(text)) == ["aurora watch"])
        #expect(Self.tinted(FindMark.search("watch aurora").marked(AttributedString("watch the aurora"))) == ["watch", "aurora"])
    }

    @Test func theCurrentMatchIsTintedAStepMoreThanTheOthers() {
        let text = AttributedString("the aurora")
        let current = FindMark.find("aurora", current: true).marked(text).runs.compactMap(\.backgroundColor)
        let other = FindMark.find("aurora", current: false).marked(text).runs.compactMap(\.backgroundColor)
        #expect(current == [FindMark.tint(current: true)])
        #expect(other == [FindMark.tint(current: false)])
        #expect(FindMark.tint(current: true) != FindMark.tint(current: false))
        #expect(FindMark.tint(current: false) != Palette.accentTint)
    }
}

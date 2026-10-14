import Foundation
@testable import RealmMarkdown
import Testing

@Suite("An agent's prose as blocks")
struct MarkdownBlocksTests {
    static func text(_ block: MarkdownBlock?) -> String? {
        switch block {
        case .paragraph(let text), .heading(_, let text): String(text.characters)
        default: nil
        }
    }

    static func runs(_ text: AttributedString) -> [(String, InlinePresentationIntent?, URL?)] {
        text.runs.map { (String(text[$0.range].characters), $0.inlinePresentationIntent, $0.link) }
    }

    @Test func theBlocksATranscriptUses() {
        let blocks = MarkdownBlocks.parse("""
        ## Rework the mapper

        Carry the plan as **its own** event.

        - one
        - two
          1. nested

        > a quote

        ```swift
        let x = 1
        ```

        ---
        """)
        guard blocks.count == 6 else {
            Issue.record("expected six blocks, got \(blocks)")
            return
        }
        #expect(blocks[0] == .heading(level: 2, AttributedString("Rework the mapper")))
        #expect(Self.text(blocks[1]) == "Carry the plan as its own event.")
        guard case .list(let list) = blocks[2] else {
            Issue.record("no list")
            return
        }
        #expect(!list.ordered)
        #expect(list.items.count == 2)
        guard case .list(let nested) = list.items[1].blocks.last else {
            Issue.record("no nested list")
            return
        }
        #expect(nested.ordered && nested.start == 1)
        #expect(blocks[3] == .quote([.paragraph(AttributedString("a quote"))]))
        #expect(blocks[4] == .code(language: "swift", text: "let x = 1"))
        #expect(blocks[5] == .rule)
    }

    @Test func inlineMarksBecomeIntents() {
        guard case .paragraph(let text) = MarkdownBlocks.parse("plain *soft* **strong** `code` ~~gone~~").first else {
            Issue.record("no paragraph")
            return
        }
        let runs = Self.runs(text)
        #expect(runs.map(\.0) == ["plain ", "soft", " ", "strong", " ", "code", " ", "gone"])
        #expect(runs[1].1 == .emphasized)
        #expect(runs[3].1 == .stronglyEmphasized)
        #expect(runs[5].1 == .code)
        #expect(runs[7].1 == .strikethrough)
    }

    @Test func onlyWebAndMailLinksCanBeFollowed() {
        guard case .paragraph(let text) = MarkdownBlocks.parse("""
        [docs](https://realm.computer/docs) [mail](mailto:a@b.co) [file](src/app.ts) [pair](realm-mobile://pair#1.x) [js](javascript:alert(1)) https://example.com/auto
        """).first else {
            Issue.record("no paragraph")
            return
        }
        let links = Self.runs(text).filter { $0.2 != nil }.map { "\($0.0)=\($0.2!.absoluteString)" }
        #expect(links == ["docs=https://realm.computer/docs", "mail=mailto:a@b.co", "https://example.com/auto=https://example.com/auto"])
        #expect(String(text.characters).contains("pair"), "an unfollowable link keeps its words")
    }

    @Test func aPictureIsNeverFetchedOnlyNamed() {
        guard case .paragraph(let text) = MarkdownBlocks.parse("![the chart](https://example.com/chart.png) ![](file:///etc/passwd)").first else {
            Issue.record("no paragraph")
            return
        }
        let runs = Self.runs(text)
        #expect(runs.first?.0 == "the chart")
        #expect(runs.first?.2 == URL(string: "https://example.com/chart.png"))
        #expect(String(text.characters) == "the chart Image")
        #expect(runs.last?.2 == nil, "a file is not a place a tap can go")
    }

    @Test func htmlIsShownAsWritten() {
        let blocks = MarkdownBlocks.parse("<div onclick=\"x()\">hi</div>\n\nan <b>inline</b> tag")
        #expect(blocks.first == .html("<div onclick=\"x()\">hi</div>"))
        #expect(Self.text(blocks.last) == "an <b>inline</b> tag")
    }

    @Test func tablesAndTaskLists() {
        let blocks = MarkdownBlocks.parse("""
        | File | Lines |
        |:-----|------:|
        | a.ts | 12 |
        | b.ts | 3 |

        - [x] done
        - [ ] next
        """)
        guard case .table(let table) = blocks.first, case .list(let tasks) = blocks.last else {
            Issue.record("expected a table and a task list, got \(blocks)")
            return
        }
        #expect(table.alignments == [.leading, .trailing])
        #expect(table.head.map { String($0.characters) } == ["File", "Lines"])
        #expect(table.rows.map { $0.map { String($0.characters) } } == [["a.ts", "12"], ["b.ts", "3"]])
        #expect(tasks.items.map(\.checked) == [true, false])
    }

    @Test func breaksAndPlainText() {
        let blocks = MarkdownBlocks.parse("one\ntwo  \nthree")
        #expect(Self.text(blocks.first) == "one two\nthree")
        #expect(MarkdownBlocks.plainText(MarkdownBlocks.parse("# T\n\n- a\n- b")) == "T\n\na\nb")
        #expect(MarkdownBlocks.parse("").isEmpty)
    }
}

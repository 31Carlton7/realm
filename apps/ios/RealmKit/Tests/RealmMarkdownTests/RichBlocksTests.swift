import Foundation
@testable import RealmMarkdown
import Testing

@Suite("TeX in an agent's prose")
struct MathTests {
    /// The expressions in a paragraph, in order, as (tex, inline).
    static func math(_ source: String) -> [String] {
        MarkdownBlocks.parse(source).flatMap { block -> [String] in
            switch block {
            case .paragraph(let text):
                text.runs.compactMap { $0[InlineMathAttribute.self].map { "inline:\($0)" } }
            case .math(let tex):
                ["display:\(tex)"]
            default:
                []
            }
        }
    }

    static func words(_ source: String) -> String {
        MarkdownBlocks.plainText(MarkdownBlocks.parse(source))
    }

    @Test func allFourDelimiters() {
        #expect(Self.math("so $x^2$ and \\(y_1\\) hold") == ["inline:x^2", "inline:y_1"])
        #expect(Self.math("$$\\int_0^1 x\\,dx$$") == ["display:\\int_0^1 x\\,dx"])
        #expect(Self.math("\\[\na + b\n\\]") == ["display:a + b"])
    }

    @Test func pricesAreNotMath() {
        #expect(Self.math("It costs $5, and sells for $9.").isEmpty)
        #expect(Self.math("$5 and $10").isEmpty)
        #expect(Self.math("Seats run $20-$30 a month.").isEmpty, "a digit straight after the closer")
        #expect(Self.math("It came to $5 or so, in $ terms.").isEmpty, "a blank just inside the closer")
        #expect(Self.math("between $ 3 and 4 $").isEmpty)
        #expect(Self.math("an escaped \\$x\\$ stays").isEmpty)
        #expect(Self.words("It costs $5, and sells for $9.") == "It costs $5, and sells for $9.")
        #expect(Self.words("$5 and $10") == "$5 and $10")
    }

    @Test func codeIsNeverMath() {
        let blocks = MarkdownBlocks.parse("run `echo $HOME` and $x$\n\n```sh\nexport A=$B$C\n```")
        #expect(Self.math("run `echo $HOME` and $x$") == ["inline:x"])
        #expect(blocks.last == .code(language: "sh", text: "export A=$B$C"))
        guard case .paragraph(let text) = blocks.first else {
            Issue.record("no paragraph")
            return
        }
        #expect(text.runs.contains { String(text[$0.range].characters) == "echo $HOME" && $0.inlinePresentationIntent == .code })
    }

    /// cmark would read the underscores as emphasis and drop the backslashes as escapes.
    @Test func theTexReachesTheDrawerAsWritten() {
        #expect(Self.math("$a_1 + b_1 = \\frac{c}{d}$") == ["inline:a_1 + b_1 = \\frac{c}{d}"])
        #expect(Self.math("$\\{ x \\mid x > 0 \\}$") == ["inline:\\{ x \\mid x > 0 \\}"])
    }

    @Test func displayMathInsideAParagraphStandsOnItsOwnLine() {
        let blocks = MarkdownBlocks.parse("The sum is\n$$\\sum_{i=1}^n i$$\nfor every n.")
        #expect(blocks.count == 3)
        #expect(MarkdownBlocksTests.text(blocks.first) == "The sum is")
        #expect(blocks[1] == .math("\\sum_{i=1}^n i"))
        #expect(MarkdownBlocksTests.text(blocks.last) == "for every n.")
    }

    @Test func aPlaceholderOutsideProseIsPutBack() {
        #expect(MarkdownBlocks.parse("    indented $x$ code") == [.code(language: nil, text: "indented $x$ code")])
        #expect(MarkdownBlocks.parse("<div>$y$</div>") == [.html("<div>$y$</div>")])
    }
}

@Suite("Blocks Realm draws")
struct UiBlockTests {
    static func block(_ fence: String, _ body: String) -> MarkdownBlock? {
        MarkdownBlocks.parse("```\(fence)\n\(body)\n```").first
    }

    static func reason(_ fence: String, _ body: String) -> String? {
        if case .undrawn(_, _, let reason) = block(fence, body) { return reason }
        return nil
    }

    @Test func eachChartKind() throws {
        for kind in ["columns", "bars", "lines"] {
            let block = Self.block("realm-chart", #"{"kind":"\#(kind)","title":"Size","unit":"KB","x":["a",2024],"series":[{"label":"app","values":[1,null]}]}"#)
            guard case .chart(let chart, _) = block else {
                Issue.record("\(kind) did not draw: \(String(describing: block))")
                continue
            }
            #expect(chart.kind.rawValue == kind)
            #expect(chart.x == ["a", "2024"], "a year written as a number is a label")
            #expect(chart.series.first?.values == [1, nil])
            #expect(chart.unit == "KB")
        }
        guard case .chart(let spark, _) = Self.block("realm-chart", #"{"kind":"sparkline","title":"Latency","series":[{"label":"p50","values":[3,4,5]}]}"#) else {
            Issue.record("the sparkline did not draw")
            return
        }
        #expect(spark.labels == ["1", "2", "3"])
    }

    @Test func aChartThatDoesNotParseStaysCodeWithItsReason() {
        #expect(Self.reason("realm-chart", "{kind: columns")?.hasPrefix("not JSON") == true)
        #expect(Self.reason("realm-chart", #"{"kind":"pie","title":"x","x":["a"],"series":[{"label":"s","values":[1]}]}"#)
            == "kind: not columns, bars, lines or sparkline")
        #expect(Self.reason("realm-chart", #"{"kind":"columns","x":["a"],"series":[{"label":"s","values":[1]}]}"#) == "title: missing")
        #expect(Self.reason("realm-chart", #"{"kind":"columns","title":"t","x":["a"],"series":[{"label":"  ","values":[1]}]}"#) == "series 1, label: empty")
        #expect(Self.reason("realm-chart", #"{"kind":"lines","title":"t","x":["a"],"series":[{"label":"s","values":["1"]}]}"#)
            == "series 1, value 1: expected number, received string")
        #expect(Self.reason("realm-chart", #"{"kind":"columns","title":"t","series":[{"label":"s","values":[1]}]}"#) == "columns need x labels")
        #expect(Self.reason("realm-chart", #"{"kind":"columns","title":"t","x":["a","b"],"series":[{"label":"s","values":[1]}]}"#)
            == "\"s\" has 1 values for 2 x labels")
        #expect(Self.reason("realm-chart", #"{"kind":"bars","title":"t","x":["a"],"series":[{"label":"s","values":[-1]}]}"#)?
            .hasPrefix("\"s\" has a negative value") == true)
        #expect(Self.reason("realm-chart", #"{"kind":"bars","title":"t","x":["a"],"series":[{"label":"s","values":[1]},{"label":"u","values":[2]}]}"#)
            == "bars take one series — columns or lines take several")
        #expect(Self.reason("realm-chart", #"{"kind":"lines","title":"t","x":["a"],"series":[{"label":"s","values":[null]}]}"#)
            == "every value is null, so there is nothing to draw")
        guard case .undrawn(let language, let text, _) = Self.block("realm-chart", "{nope") else {
            Issue.record("a broken chart is not code")
            return
        }
        #expect(language == "realm-chart" && text == "{nope")
    }

    @Test func aComparison() {
        guard case .comparison(let compare, _) = Self.block("realm-compare", #"""
        {"options":["SQLite","Postgres"],"rows":[{"label":"Setup","values":["none",""]},{"label":"Free","values":[true,3.5]}],"pick":"SQLite"}
        """#) else {
            Issue.record("the comparison did not draw")
            return
        }
        #expect(compare.heading == "SQLite or Postgres")
        #expect(compare.pickIndex == 0)
        #expect(compare.rows[0].values == ["none", nil], "a blank cell says nothing")
        #expect(compare.rows[1].values == ["Yes", "3.5"])
    }

    @Test func aComparisonThatDoesNotParse() {
        #expect(Self.reason("realm-compare", #"{"options":["a"],"rows":[{"label":"r","values":[1]}]}"#) == "options: fewer than two options")
        #expect(Self.reason("realm-compare", #"{"options":["a","a"],"rows":[{"label":"r","values":[1,2]}]}"#) == "two options have the same name")
        #expect(Self.reason("realm-compare", #"{"options":["a","b"],"rows":[{"label":"r","values":[1]}]}"#) == "\"r\" has 1 values for 2 options")
        #expect(Self.reason("realm-compare", #"{"options":["a","b"],"rows":[{"label":"r","values":[1,2]}],"pick":"c"}"#)
            == "the pick, \"c\", is not one of the options")
        #expect(Self.reason("realm-compare", #"{"options":["a","b"],"rows":[{"label":"r","values":[{},2]}]}"#) == "row 1, value 1: not text")
    }

    @Test func diagrams() {
        #expect(Self.block("mermaid", "flowchart LR\n  A --> B") == .diagram("flowchart LR\n  A --> B"))
        #expect(Self.block("Mermaid title", "graph TD; A-->B") == .diagram("graph TD; A-->B"), "the first word, in any case")
        #expect(Self.reason("mermaid", "flowchart LR\n  A@{ img: \"https://x.test/a.png\" }")?.hasPrefix("it draws a picture") == true)
        #expect(Self.reason("mermaid", Array(repeating: "A-->B", count: 301).joined(separator: "\n")) == "301 lines, past the 300 Realm draws")
        #expect(Self.reason("mermaid", "  ") == "the block is empty")
    }

    /// A message mid-stream has a fence that has not closed: it is code until it does.
    @Test func anOpenFenceIsStillCode() {
        #expect(MarkdownBlocks.parse("```realm-chart\n{\"kind\":") == [.code(language: "realm-chart", text: "{\"kind\":")])
        #expect(MarkdownBlocks.parse("```mermaid\ngraph TD; A-->B") == [.code(language: "mermaid", text: "graph TD; A-->B")])
    }

    @Test func otherFencesAreCode() {
        #expect(Self.block("json", #"{"kind":"columns"}"#) == .code(language: "json", text: #"{"kind":"columns"}"#))
    }
}

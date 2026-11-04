import RealmMarkdown
import SwiftUI
import Testing
import UIKit
@testable import Realm

@Suite("Blocks Realm draws, on the phone")
@MainActor
struct RichBlocksTests {
    static func blocks(_ markdown: String) -> [MarkdownBlock] { MarkdownBlocks.parse(markdown) }

    @Test func aValueIsWrittenInItsUnit() {
        #expect(ChartUnit("KB").exact(1210) == "1,210 KB")
        #expect(ChartUnit("KB").short(1210) == "1.2K", "a word of a unit is left to the head")
        #expect(ChartUnit("$").exact(-4.5) == "-$4.5")
        #expect(ChartUnit("%").short(18) == "18%")
        #expect(ChartUnit(nil).exact(3) == "3")
    }

    /// A diagram is drawn again for the other face; its colours are Realm's, resolved over the ground.
    @Test func eachFaceHasItsOwnDiagramColours() {
        let dark = DiagramColors(dark: true, ground: Palette.surface)
        let light = DiagramColors(dark: false, ground: Palette.surface)
        #expect(dark != light)
        #expect(light.tokens["ground"] as? String == "#ffffff")
        #expect((dark.tokens["series"] as? [String])?.count == 8)
        #expect(BlockDrawer.diagramKey("graph TD; A-->B", colors: dark) != BlockDrawer.diagramKey("graph TD; A-->B", colors: light))
    }

    @Test func texIsDrawnOnceAndKept() async throws {
        let drawing = await BlockDrawer.shared.math("x^2 + \\frac{1}{2}", display: false, size: 17)
        let image = try #require(drawing.image)
        #expect(image.size.width > 20 && image.size.height > 12)
        #expect(image.renderingMode == .alwaysTemplate, "drawn as a mask, so it takes the sentence's ink in either face")
        #expect(drawing.depth > 0)
        #expect(BlockDrawer.shared.cached(BlockDrawer.mathKey("x^2 + \\frac{1}{2}", display: false, size: 17)) === drawing)
        #expect(await BlockDrawer.shared.math("\\frac{", display: true, size: 17).image == nil, "TeX that does not parse is left as written")
    }

    @Test func aDiagramIsDrawnOrSaysWhyNot() async throws {
        let colors = DiagramColors(dark: false, ground: Palette.surface)
        let flow = await BlockDrawer.shared.diagram("flowchart LR\n  A[Push] --> B[Ship]", colors: colors)
        let image = try #require(flow.image, "\(flow.reason ?? "")")
        #expect(image.size.width > image.size.height)
        #expect(flow.name == "Flowchart")
        let sequence = await BlockDrawer.shared.diagram("sequenceDiagram\n  P->>R: frame", colors: colors)
        #expect(sequence.name == "Sequence diagram")
        let broken = await BlockDrawer.shared.diagram("flowchart LR\n  A --> ", colors: colors)
        #expect(broken.image == nil && broken.reason?.isEmpty == false)
        let pie = await BlockDrawer.shared.diagram("pie\n  \"a\": 1", colors: colors)
        #expect(pie.image == nil && pie.reason == "this kind of diagram is drawn on the Mac, not the phone")
    }

    /// Every block keeps to the transcript's width: a wide one scrolls inside its panel rather than
    /// widening the column.
    @Test func wideBlocksKeepToTheColumn() throws {
        let compare = #"{"options":["SQLite","Files","iCloud","Postgres","Redis"],"rows":[{"label":"Setup","values":["None","None","A signed-in account","A server","A server"]}],"pick":"SQLite"}"#
        let chart = #"{"kind":"columns","title":"Size","x":["a","b","c","d","e","f","g","h","i","j","k","l"],"series":[{"label":"s","values":[1,2,3,4,5,6,7,8,9,10,11,12]}]}"#
        for markdown in ["```realm-compare\n\(compare)\n```", "```realm-chart\n\(chart)\n```"] {
            let fitted = UIHostingController(rootView: MarkdownView(markdown)).sizeThatFits(in: CGSize(width: 360, height: 4_000))
            #expect(fitted.width <= 360)
            #expect(fitted.height > 100)
        }
    }

    @Test func theRecommendedOptionIsSaidInWords() throws {
        let compare = #"{"options":["SQLite","Files"],"rows":[{"label":"Works offline","values":[true,false]}],"pick":"SQLite"}"#
        let words = try Drawing.words(MarkdownView("```realm-compare\n\(compare)\n```"), dark: false)
        #expect(words.contains("Recommended"))
        #expect(words.contains("Works offline"))
        #expect(words.contains("Yes") && words.contains("No"))
    }

    @Test func aBrokenChartIsItsCodeAndWhy() throws {
        let words = try Drawing.words(MarkdownView("```realm-chart\n{\"kind\": \"pie\"}\n```"), dark: false)
        #expect(words.contains("Not drawn"))
        #expect(words.contains("pie"))
    }
}

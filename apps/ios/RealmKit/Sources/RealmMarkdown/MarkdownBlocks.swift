import Foundation
import Markdown

/// An agent's prose as the blocks a transcript uses, parsed by Apple's swift-markdown (cmark-gfm) and
/// drawn by the app's own views. Text stays text: HTML is shown as written, a picture is never
/// fetched, and only a web or mail link can be followed — a tap opens it in Safari.
public indirect enum MarkdownBlock: Hashable, Sendable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case code(language: String?, text: String)
    case quote([MarkdownBlock])
    case list(MarkdownList)
    case table(MarkdownTable)
    case rule
    /// Raw HTML, drawn as the characters it is.
    case html(String)
    /// TeX set on a line of its own: `$$…$$` or `\[…\]`.
    case math(String)
    /// A ```mermaid body, for the app to draw.
    case diagram(String)
    /// A ```realm-chart body, and the JSON it was read from.
    case chart(ChartBlock, source: String)
    /// A ```realm-compare body, and the JSON it was read from.
    case comparison(CompareBlock, source: String)
    /// A block fence whose body is not a block: shown as the code it is, with why.
    case undrawn(language: String, text: String, reason: String)
}

/// A run of prose that is inline TeX — `$…$` or `\(…\)` — holding the expression. The run's
/// characters are the expression too, so text that ignores the mark still says what it was.
public enum InlineMathAttribute: AttributedStringKey {
    public typealias Value = String
    public static let name = "realm.inlineMath"
}

/// Display TeX met inside a paragraph, before the paragraph is broken around it.
enum DisplayMathAttribute: AttributedStringKey {
    typealias Value = String
    static let name = "realm.displayMath"
}

public struct MarkdownList: Hashable, Sendable {
    public let ordered: Bool
    /// The first item's number, for an ordered list.
    public let start: Int
    public let items: [MarkdownListItem]
}

public struct MarkdownListItem: Hashable, Sendable {
    /// A task list's box: nil when the item has none.
    public let checked: Bool?
    public let blocks: [MarkdownBlock]
}

public struct MarkdownTable: Hashable, Sendable {
    public enum Alignment: Hashable, Sendable { case leading, center, trailing }
    public let alignments: [Alignment]
    public let head: [AttributedString]
    public let rows: [[AttributedString]]
}

public enum MarkdownBlocks {
    /// The link schemes a tap may follow. Anything else — a file, a custom scheme, the app's own
    /// pairing links — stays text, so a page an agent read cannot make the phone do something.
    public static let followableSchemes: Set<String> = ["http", "https", "mailto"]

    public static func parse(_ source: String) -> [MarkdownBlock] {
        var math = MathSpans()
        let masked = math.mask(source)
        return blocks(Document(parsing: masked).children, Source(math: math, lines: masked.split(separator: "\n", omittingEmptySubsequences: false)))
    }

    /// What a parse reads back besides the tree: the expressions swapped out of it, and its lines,
    /// for telling a fence that has closed from one still streaming.
    struct Source {
        var math = MathSpans()
        var lines: [Substring] = []
    }

    /// The text of a block run with every mark removed, for accessibility and copying.
    public static func plainText(_ blocks: [MarkdownBlock]) -> String {
        blocks.map { block -> String in
            switch block {
            case .paragraph(let text), .heading(_, let text): String(text.characters)
            case .code(_, let text), .html(let text), .math(let text), .diagram(let text), .undrawn(_, let text, _),
                 .chart(_, let text), .comparison(_, let text): text
            case .quote(let inner): plainText(inner)
            case .list(let list): list.items.map { plainText($0.blocks) }.joined(separator: "\n")
            case .table(let table): ([table.head] + table.rows).map { $0.map { String($0.characters) }.joined(separator: "\t") }
                .joined(separator: "\n")
            case .rule: ""
            }
        }.joined(separator: "\n\n")
    }

    static func blocks(_ children: MarkupChildren, _ source: Source) -> [MarkdownBlock] {
        children.flatMap { markup -> [MarkdownBlock] in
            if let paragraph = markup as? Paragraph { return paragraphBlocks(paragraph, source) }
            return block(markup, source).map { [$0] } ?? []
        }
    }

    /// A paragraph, broken where display TeX sits inside it: the sentence before, the expression on
    /// its own line, the sentence after.
    static func paragraphBlocks(_ paragraph: Paragraph, _ source: Source) -> [MarkdownBlock] {
        let text = inline(paragraph.children, source)
        guard text.runs.contains(where: { $0[DisplayMathAttribute.self] != nil }) else { return [.paragraph(text)] }
        var blocks: [MarkdownBlock] = []
        var sentence = AttributedString()
        func flush() {
            let words = String(sentence.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !words.isEmpty { blocks.append(.paragraph(trimmed(sentence))) }
            sentence = AttributedString()
        }
        for run in text.runs {
            if let tex = run[DisplayMathAttribute.self] {
                flush()
                blocks.append(.math(tex))
            } else {
                sentence += text[run.range]
            }
        }
        flush()
        return blocks
    }

    static func block(_ markup: Markup, _ source: Source) -> MarkdownBlock? {
        switch markup {
        case let paragraph as Paragraph:
            return .paragraph(inline(paragraph.children, source))
        case let heading as Heading:
            return .heading(level: heading.level, inline(heading.children, source))
        case let code as CodeBlock:
            let language = code.language?.trimmingCharacters(in: .whitespaces)
            let text = source.math.restore(trimmingFinalNewline(code.code))
            if let language, let kind = UiBlocks.kind(info: language), fenceClosed(code, source) {
                switch UiBlocks.parse(kind, text) {
                case .success(let block): return block
                case .failure(let failure): return .undrawn(language: language, text: text, reason: failure.reason)
                }
            }
            return .code(language: language?.isEmpty == false ? language : nil, text: text)
        case let quote as BlockQuote:
            return .quote(blocks(quote.children, source))
        case let list as UnorderedList:
            return .list(MarkdownList(ordered: false, start: 1, items: list.listItems.map { item($0, source) }))
        case let list as OrderedList:
            return .list(MarkdownList(ordered: true, start: Int(list.startIndex), items: list.listItems.map { item($0, source) }))
        case let table as Markdown.Table:
            return .table(MarkdownTable(
                alignments: table.columnAlignments.map(alignment),
                head: table.head.cells.map { inline($0.children, source) },
                rows: table.body.rows.map { row in row.cells.map { inline($0.children, source) } }
            ))
        case is ThematicBreak:
            return .rule
        case let html as HTMLBlock:
            return .html(source.math.restore(trimmingFinalNewline(html.rawHTML)))
        default:
            // Anything else a parser may grow is kept as its words rather than dropped.
            let text = source.math.restore(markup.format()).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .paragraph(AttributedString(text))
        }
    }

    /// Whether a fenced block's closing fence has arrived. Nothing is drawn from half a body: a
    /// message mid-stream is a fence that runs to the end of the text.
    static func fenceClosed(_ code: CodeBlock, _ source: Source) -> Bool {
        guard let range = code.range, range.lowerBound.line < range.upperBound.line,
              source.lines.indices.contains(range.upperBound.line - 1),
              let open = MathSpans.opensFence(source.lines[range.lowerBound.line - 1]) else { return false }
        return MathSpans.closesFence(source.lines[range.upperBound.line - 1], character: open.character, length: open.length)
    }

    static func item(_ item: ListItem, _ source: Source) -> MarkdownListItem {
        let checked: Bool? = switch item.checkbox {
        case .checked: true
        case .unchecked: false
        case nil: nil
        }
        return MarkdownListItem(checked: checked, blocks: blocks(item.children, source))
    }

    static func alignment(_ alignment: Markdown.Table.ColumnAlignment?) -> MarkdownTable.Alignment {
        switch alignment {
        case .center: .center
        case .right: .trailing
        case .left, nil: .leading
        }
    }

    static func inline(_ children: MarkupChildren, _ source: Source, intent: InlinePresentationIntent = [], link: URL? = nil) -> AttributedString {
        children.reduce(into: AttributedString()) { text, child in
            text += inline(child, source, intent: intent, link: link)
        }
    }

    static func inline(_ markup: Markup, _ source: Source, intent: InlinePresentationIntent, link: URL?) -> AttributedString {
        switch markup {
        case let text as Markdown.Text:
            return source.math.pieces(text.string).reduce(into: AttributedString()) { out, piece in
                switch piece {
                case .text(let words):
                    out += link == nil ? linkified(words, intent: intent) : run(words, intent: intent, link: link)
                case .math(let span):
                    var tex = run(span.tex, intent: intent, link: link)
                    if span.display { tex[DisplayMathAttribute.self] = span.tex } else { tex[InlineMathAttribute.self] = span.tex }
                    out += tex
                }
            }
        case let emphasis as Emphasis:
            return inline(emphasis.children, source, intent: intent.union(.emphasized), link: link)
        case let strong as Strong:
            return inline(strong.children, source, intent: intent.union(.stronglyEmphasized), link: link)
        case let strike as Strikethrough:
            return inline(strike.children, source, intent: intent.union(.strikethrough), link: link)
        case let code as InlineCode:
            return run(source.math.restore(code.code), intent: intent.union(.code), link: link)
        case let anchor as Markdown.Link:
            return inline(anchor.children, source, intent: intent, link: followable(source.math.restore(anchor.destination ?? "")) ?? link)
        case let image as Markdown.Image:
            // Never fetched: its words, linked to where it lives when that is on the web.
            let words = image.plainText.isEmpty ? "Image" : source.math.restore(image.plainText)
            return run(words, intent: intent, link: followable(source.math.restore(image.source ?? "")) ?? link)
        case is SoftBreak:
            return run(" ", intent: intent, link: link)
        case is LineBreak:
            return run("\n", intent: intent, link: link)
        case let html as InlineHTML:
            return run(source.math.restore(html.rawHTML), intent: intent, link: link)
        default:
            return run(source.math.restore(markup.format()), intent: intent, link: link)
        }
    }

    /// A sentence cut where display TeX was, without the line break or space it was cut at.
    static func trimmed(_ text: AttributedString) -> AttributedString {
        var text = text
        while let first = text.characters.first, first.isWhitespace { text.removeSubrange(text.startIndex..<text.index(afterCharacter: text.startIndex)) }
        while let last = text.characters.last, last.isWhitespace { text.removeSubrange(text.index(beforeCharacter: text.endIndex)..<text.endIndex) }
        return text
    }

    static func run(_ string: String, intent: InlinePresentationIntent, link: URL?) -> AttributedString {
        var text = AttributedString(string)
        if !intent.isEmpty { text.inlinePresentationIntent = intent }
        if let link { text.link = link }
        return text
    }

    static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// A web address written out in the prose is a link too, as it is on the desktop. Only one spelled
    /// with its scheme: `realm.computer` alone is a name, not an address.
    static func linkified(_ string: String, intent: InlinePresentationIntent) -> AttributedString {
        guard let detector, string.contains("://") else { return run(string, intent: intent, link: nil) }
        var text = AttributedString()
        var cursor = string.startIndex
        for match in detector.matches(in: string, range: NSRange(string.startIndex..., in: string)) {
            guard let range = Range(match.range, in: string), range.lowerBound >= cursor else { continue }
            let spelled = String(string[range])
            let lowered = spelled.lowercased()
            guard lowered.hasPrefix("https://") || lowered.hasPrefix("http://"), let url = followable(spelled) else { continue }
            text += run(String(string[cursor..<range.lowerBound]), intent: intent, link: nil)
            text += run(spelled, intent: intent, link: url)
            cursor = range.upperBound
        }
        text += run(String(string[cursor...]), intent: intent, link: nil)
        return text
    }

    static func followable(_ destination: String?) -> URL? {
        guard let destination, let url = URL(string: destination.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), followableSchemes.contains(scheme) else { return nil }
        if scheme != "mailto", url.host?.isEmpty != false { return nil }
        return url
    }

    static func trimmingFinalNewline(_ text: String) -> String {
        text.hasSuffix("\n") ? String(text.dropLast()) : text
    }
}

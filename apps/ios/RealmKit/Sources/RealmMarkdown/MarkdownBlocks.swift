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
        blocks(Document(parsing: source).children)
    }

    /// The text of a block run with every mark removed, for accessibility and copying.
    public static func plainText(_ blocks: [MarkdownBlock]) -> String {
        blocks.map { block -> String in
            switch block {
            case .paragraph(let text), .heading(_, let text): String(text.characters)
            case .code(_, let text), .html(let text): text
            case .quote(let inner): plainText(inner)
            case .list(let list): list.items.map { plainText($0.blocks) }.joined(separator: "\n")
            case .table(let table): ([table.head] + table.rows).map { $0.map { String($0.characters) }.joined(separator: "\t") }
                .joined(separator: "\n")
            case .rule: ""
            }
        }.joined(separator: "\n\n")
    }

    static func blocks(_ children: MarkupChildren) -> [MarkdownBlock] {
        children.compactMap(block)
    }

    static func block(_ markup: Markup) -> MarkdownBlock? {
        switch markup {
        case let paragraph as Paragraph:
            return .paragraph(inline(paragraph.children))
        case let heading as Heading:
            return .heading(level: heading.level, inline(heading.children))
        case let code as CodeBlock:
            let language = code.language?.trimmingCharacters(in: .whitespaces)
            return .code(language: language?.isEmpty == false ? language : nil, text: trimmingFinalNewline(code.code))
        case let quote as BlockQuote:
            return .quote(blocks(quote.children))
        case let list as UnorderedList:
            return .list(MarkdownList(ordered: false, start: 1, items: list.listItems.map(item)))
        case let list as OrderedList:
            return .list(MarkdownList(ordered: true, start: Int(list.startIndex), items: list.listItems.map(item)))
        case let table as Markdown.Table:
            return .table(MarkdownTable(
                alignments: table.columnAlignments.map(alignment),
                head: table.head.cells.map { inline($0.children) },
                rows: table.body.rows.map { row in row.cells.map { inline($0.children) } }
            ))
        case is ThematicBreak:
            return .rule
        case let html as HTMLBlock:
            return .html(trimmingFinalNewline(html.rawHTML))
        default:
            // Anything else a parser may grow is kept as its words rather than dropped.
            let text = markup.format().trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .paragraph(AttributedString(text))
        }
    }

    static func item(_ item: ListItem) -> MarkdownListItem {
        let checked: Bool? = switch item.checkbox {
        case .checked: true
        case .unchecked: false
        case nil: nil
        }
        return MarkdownListItem(checked: checked, blocks: blocks(item.children))
    }

    static func alignment(_ alignment: Markdown.Table.ColumnAlignment?) -> MarkdownTable.Alignment {
        switch alignment {
        case .center: .center
        case .right: .trailing
        case .left, nil: .leading
        }
    }

    static func inline(_ children: MarkupChildren, intent: InlinePresentationIntent = [], link: URL? = nil) -> AttributedString {
        children.reduce(into: AttributedString()) { text, child in
            text += inline(child, intent: intent, link: link)
        }
    }

    static func inline(_ markup: Markup, intent: InlinePresentationIntent, link: URL?) -> AttributedString {
        switch markup {
        case let text as Markdown.Text:
            return link == nil ? linkified(text.string, intent: intent) : run(text.string, intent: intent, link: link)
        case let emphasis as Emphasis:
            return inline(emphasis.children, intent: intent.union(.emphasized), link: link)
        case let strong as Strong:
            return inline(strong.children, intent: intent.union(.stronglyEmphasized), link: link)
        case let strike as Strikethrough:
            return inline(strike.children, intent: intent.union(.strikethrough), link: link)
        case let code as InlineCode:
            return run(code.code, intent: intent.union(.code), link: link)
        case let anchor as Markdown.Link:
            return inline(anchor.children, intent: intent, link: followable(anchor.destination) ?? link)
        case let image as Markdown.Image:
            // Never fetched: its words, linked to where it lives when that is on the web.
            let words = image.plainText.isEmpty ? "Image" : image.plainText
            return run(words, intent: intent, link: followable(image.source) ?? link)
        case is SoftBreak:
            return run(" ", intent: intent, link: link)
        case is LineBreak:
            return run("\n", intent: intent, link: link)
        case let html as InlineHTML:
            return run(html.rawHTML, intent: intent, link: link)
        default:
            return run(markup.format(), intent: intent, link: link)
        }
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

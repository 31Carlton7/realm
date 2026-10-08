import RealmMarkdown
import SwiftUI

/// An agent's prose, drawn from RealmMarkdown's blocks with Realm's own views: no web view, no
/// remote images, links followed only on a tap.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight

    init(_ text: String) {
        blocks = ParsedMarkdown.blocks(for: text)
    }

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block, fonts: fonts)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var fonts: RealmFonts {
        RealmFonts(dynamicTypeSize: dynamicTypeSize, boldText: legibilityWeight == .bold)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    let fonts: RealmFonts
    @ScaledMetric(relativeTo: .body) private var lineSpacing: CGFloat = 4

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(styled(text, base: .body))
                .lineSpacing(lineSpacing)
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(styled(text, base: headingStyle(level), weight: .title))
                .foregroundStyle(Palette.ink)
                .padding(.top, level <= 2 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Palette.lineStrong)
                    .frame(width: 3)
                MarkdownView(blocks: inner)
                    .foregroundStyle(Palette.ink2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let list):
            ListBlockView(list: list, fonts: fonts)
        case .table(let table):
            TableBlockView(table: table, fonts: fonts)
        case .rule:
            Rectangle()
                .fill(Palette.divider)
                .frame(height: 1)
                .padding(.vertical, 4)
                .accessibilityHidden(true)
        case .html(let html):
            Text(html)
                .mono(.footnote)
                .foregroundStyle(Palette.ink2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func headingStyle(_ level: Int) -> UIFont.TextStyle {
        switch level {
        case 1: .title2
        case 2: .title3
        case 3: .headline
        default: .subheadline
        }
    }

    /// Fonts for each run by its marks: Inter at the block's size, JetBrains Mono for code, links in
    /// the accent ink with no underline.
    private func styled(_ text: AttributedString, base: UIFont.TextStyle, weight: RealmType.Weight = .regular) -> AttributedString {
        var text = text
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            let strong = intent.contains(.stronglyEmphasized)
            let font: Font = intent.contains(.code)
                ? fonts.mono(base == .body ? .subheadline : base)
                : fonts.inter(base, strong ? .strong : weight, italic: intent.contains(.emphasized))
            text[run.range].font = font
            if intent.contains(.code) { text[run.range].backgroundColor = Palette.surface }
            if intent.contains(.strikethrough) { text[run.range].strikethroughStyle = .single }
            if run.link != nil { text[run.range].foregroundColor = Palette.accentInk }
        }
        return text
    }
}

/// A fenced block: a panel the eye rests in, so it wears the continuous corner and no ring. Long
/// lines scroll sideways; they are read to their last character, so nothing masks the edge.
private struct CodeBlockView: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language {
                Text(language)
                    .mono(.caption1)
                    .foregroundStyle(Palette.ink3)
            }
            ScrollView(.horizontal) {
                Text(text)
                    .mono(.footnote)
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .fixedSize()
            }
            .scrollIndicators(.hidden)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface(Palette.surface, radius: Radius.panel)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(language.map { "\($0) code: \(text)" } ?? "Code: \(text)")
    }
}

private struct ListBlockView: View {
    let list: MarkdownList
    let fonts: RealmFonts

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(index: index, item: item)
                        .frame(minWidth: list.ordered ? 22 : 14, alignment: .trailing)
                    MarkdownView(blocks: item.blocks)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: MarkdownListItem) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square" : "square")
                .foregroundStyle(checked ? Palette.green : Palette.ink2)
                .accessibilityLabel(checked ? "Done" : "Not done")
        } else if list.ordered {
            Text("\(list.start + index).")
                .font(fonts.inter(.body))
                .monospacedDigit()
                .foregroundStyle(Palette.ink2)
        } else {
            Text("•")
                .font(fonts.inter(.body))
                .foregroundStyle(Palette.ink2)
                .accessibilityHidden(true)
        }
    }
}

/// A table at its full evidence width, scrolling sideways when it is wider than the screen.
private struct TableBlockView: View {
    let table: MarkdownTable
    let fonts: RealmFonts

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(table.head.enumerated()), id: \.offset) { column, cell in
                        Text(cell)
                            .font(fonts.inter(.subheadline, .title))
                            .foregroundStyle(Palette.ink)
                            .gridColumnAlignment(alignment(column))
                    }
                }
                Rectangle()
                    .fill(Palette.divider)
                    .frame(height: 1)
                    .gridCellUnsizedAxes(.horizontal)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(cell)
                                .font(fonts.inter(.subheadline))
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink)
                        }
                    }
                }
            }
            .padding(14)
        }
        .scrollIndicators(.hidden)
        .surface(Palette.surface, radius: Radius.card)
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        guard column < table.alignments.count else { return .leading }
        switch table.alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// Parsed prose by its text: a transcript redraws often and its rows seldom change.
final class ParsedMarkdown {
    let blocks: [MarkdownBlock]

    private init(_ blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, ParsedMarkdown> = {
        let cache = NSCache<NSString, ParsedMarkdown>()
        cache.countLimit = 400
        return cache
    }()

    static func blocks(for text: String) -> [MarkdownBlock] {
        if let parsed = cache.object(forKey: text as NSString) { return parsed.blocks }
        let blocks = MarkdownBlocks.parse(text)
        cache.setObject(ParsedMarkdown(blocks), forKey: text as NSString)
        return blocks
    }
}

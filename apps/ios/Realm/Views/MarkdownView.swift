import RealmMarkdown
import SwiftUI
import UIKit

/// What a block of prose stands on. A panel inside it — a fenced block, a table, a run of code —
/// takes its fill a step off that ground, so the same block reads as a panel on the transcript and as
/// a well inside a card.
enum ProseGround {
    case transcript, card

    var panel: Color { self == .card ? Fill.well : Fill.card }
}

extension EnvironmentValues {
    @Entry var proseGround: ProseGround = .transcript
}

/// An agent's prose, drawn from RealmMarkdown's blocks with Realm's own views: no web view, no
/// remote images, links followed only on a tap.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]

    init(_ text: String) {
        blocks = ParsedMarkdown.blocks(for: text)
    }

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock
    @Environment(\.proseGround) private var ground
    @Environment(\.legibilityWeight) private var legibilityWeight
    @ScaledMetric(relativeTo: .body) private var lineSpacing: CGFloat = 3

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(styled(text, base: .body))
                .lineSpacing(lineSpacing)
                .foregroundStyle(Palette.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(styled(text, base: Self.headingStyle(level), weight: Self.headingWeight(level)))
                .foregroundStyle(Palette.ink)
                .padding(.top, level <= 2 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 12) {
                Capsule()
                    .fill(Palette.lineStrong)
                    .frame(width: 3)
                MarkdownView(blocks: inner)
                    .foregroundStyle(Palette.ink2)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .list(let list):
            ListBlockView(list: list)
        case .table(let table):
            TableBlockView(table: table)
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

    static func headingStyle(_ level: Int) -> Font.TextStyle {
        switch level {
        case 1: .title2
        case 2: .title3
        case 3: .headline
        default: .subheadline
        }
    }

    static func headingWeight(_ level: Int) -> Font.Weight {
        level <= 2 ? .bold : .semibold
    }

    /// Fonts for each run by its marks: the system face at the block's style, JetBrains Mono for code
    /// on a chip a step off the ground, links in the accent ink with no underline.
    private func styled(_ text: AttributedString, base: Font.TextStyle, weight: Font.Weight = .regular) -> AttributedString {
        var text = text
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.code) {
                // Mono reads a size larger than the face beside it, so it sits a step down.
                let style: Font.TextStyle = base == .body ? .callout : base
                text[run.range].font = RealmType.mono(style, medium: legibilityWeight == .bold)
                text[run.range].backgroundColor = ground.panel
            } else {
                var font = Font.system(base).weight(intent.contains(.stronglyEmphasized) ? .semibold : weight)
                if intent.contains(.emphasized) { font = font.italic() }
                text[run.range].font = font
            }
            if intent.contains(.strikethrough) { text[run.range].strikethroughStyle = .single }
            if run.link != nil { text[run.range].foregroundColor = Palette.accentInk }
        }
        return text
    }
}

/// A fenced block: a panel the eye rests in, so it wears the continuous corner and no ring, with its
/// language and a copy control as its own chrome. Long lines scroll sideways; they are read to their
/// last character, so nothing masks the edge.
private struct CodeBlockView: View {
    let language: String?
    let text: String
    @Environment(\.proseGround) private var ground
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(language ?? "Code")
                .font(language == nil ? .footnote : RealmType.mono(.footnote))
                .foregroundStyle(Palette.ink2)
                .padding(.horizontal, 14)
                .padding(.top, 12)
            ScrollView(.horizontal) {
                Text(text)
                    .mono(.footnote)
                    .foregroundStyle(Palette.ink)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
            .scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The copy control sits in the head's corner, its 44-point target over the panel's edge.
        .overlay(alignment: .topTrailing) {
            Button {
                UIPasteboard.general.string = text
                copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink2)
                    .contentTransition(.symbolEffect(.replace))
                    .touchTarget()
            }
            .buttonStyle(.plain)
            .padding(.top, 1)
            .padding(.trailing, 2)
            .accessibilityLabel(copied ? "Copied" : "Copy code")
            .sensoryFeedback(.success, trigger: copied) { _, new in new }
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        }
        .surface(ground.panel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(language.map { "\($0) code" } ?? "Code")
    }
}

private struct ListBlockView: View {
    let list: MarkdownList

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(index: index, item: item)
                        .frame(minWidth: list.ordered ? 24 : 14, alignment: .trailing)
                    MarkdownView(blocks: item.blocks)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(index: Int, item: MarkdownListItem) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(checked ? Palette.green : Palette.ink2)
                .accessibilityLabel(checked ? "Done" : "Not done")
        } else if list.ordered {
            Text("\(list.start + index).")
                .font(.body)
                .monospacedDigit()
                .foregroundStyle(Palette.ink2)
        } else {
            Text("•")
                .font(.body.weight(.bold))
                .foregroundStyle(Palette.ink2)
                .accessibilityHidden(true)
        }
    }
}

/// A table at its full evidence width, scrolling sideways when it is wider than the screen.
private struct TableBlockView: View {
    let table: MarkdownTable
    @Environment(\.proseGround) private var ground

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 9) {
                GridRow {
                    ForEach(Array(table.head.enumerated()), id: \.offset) { column, cell in
                        Text(cell)
                            .font(.subheadline.weight(.semibold))
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
                                .font(.subheadline)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink)
                        }
                    }
                }
            }
            .padding(14)
        }
        .scrollIndicators(.hidden)
        .surface(ground.panel)
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

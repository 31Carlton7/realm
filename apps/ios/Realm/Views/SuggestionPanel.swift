import RealmKit
import SwiftUI

/// What the composer's `/` or `@` offers for the token under the caret.
enum Suggestions: Equatable {
    case commands([ComposerCommand])
    case mentions([MentionRow])

    var count: Int {
        switch self {
        case .commands(let commands): commands.count
        case .mentions(let rows): rows.count
        }
    }
}

/// The list over the composer while a `/` or `@` is typed, as the desktop's popover over its prompter:
/// a card standing on the composer's top edge, so it is next to the keyboard and in reach of a thumb.
/// One row a line — its mark, its name, and what it does in quiet words — and in the tour a bare `@`
/// opens, a quiet head over each kind.
struct SuggestionPanel: View {
    let suggestions: Suggestions
    /// The row a hardware keyboard's arrows have reached: Return or Tab picks it.
    let active: Int
    let pickCommand: (ComposerCommand) -> Void
    let pickMention: (MentionRow) -> Void
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44
    @ScaledMetric(relativeTo: .caption) private var headHeight: CGFloat = 30

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch suggestions {
                case .commands(let commands):
                    ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                        Button { pickCommand(command) } label: { CommandRow(command: command, active: index == active) }
                            .buttonStyle(SuggestionRowStyle())
                    }
                case .mentions(let rows):
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if let head = row.head {
                            Text(head)
                                .font(.caption)
                                .foregroundStyle(Palette.ink3)
                                .padding(.horizontal, 16)
                                .padding(.bottom, 4)
                                .frame(height: headHeight, alignment: .bottomLeading)
                                .accessibilityAddTraits(.isHeader)
                        }
                        Button { pickMention(row) } label: { MentionRowView(row: row, active: index == active) }
                            .buttonStyle(SuggestionRowStyle())
                    }
                }
            }
            .padding(.vertical, 6)
        }
        .scrollBounceBehavior(.basedOnSize)
        // As tall as its rows, up to five and a half, so a longer list shows that it scrolls.
        .frame(height: min(contentHeight, rowHeight * 5.5 + 12))
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .floatingLift()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(suggestions.isCommands ? "Commands" : "Mentions")
    }
}

extension SuggestionPanel {
    private var contentHeight: CGFloat {
        let heads = if case .mentions(let rows) = suggestions { rows.count { $0.head != nil } } else { 0 }
        return CGFloat(suggestions.count) * rowHeight + CGFloat(heads) * headHeight + 12
    }
}

extension Suggestions {
    fileprivate var isCommands: Bool {
        if case .commands = self { return true }
        return false
    }
}

/// A row lights on the press, and for the row a keyboard's arrows have reached.
private struct SuggestionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : .clear)
            .contentShape(Rectangle())
    }
}

private struct CommandRow: View {
    let command: ComposerCommand
    let active: Bool

    var body: some View {
        SuggestionLine(active: active, detail: command.hint) {
            Image(systemName: Self.symbol(command.action))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Palette.ink2)
        } name: {
            Text("/\(command.id)").mono(.body, medium: true)
        }
        .accessibilityLabel("\(command.label), /\(command.id)")
        .accessibilityHint(command.hint)
    }

    static func symbol(_ action: ComposerCommand.Action) -> String {
        switch action {
        case .mode(let id): SessionMode(rawValue: id).map(SettingWords.symbol) ?? "slider.horizontal.3"
        case .goal: "target"
        case .attach: "paperclip"
        case .user: "sparkles"
        }
    }
}

private struct MentionRowView: View {
    let row: MentionRow
    let active: Bool
    @ScaledMetric(relativeTo: .body) private var markSide: CGFloat = 22

    var body: some View {
        SuggestionLine(active: active, detail: row.detail) {
            switch row.kind {
            case .teammate(let teammate):
                TeammateMark(icon: teammate.icon, size: markSide, lead: teammate.lead)
            case .mac:
                Image(systemName: "apple.logo").font(.system(size: 15)).foregroundStyle(Palette.ink2)
            case .skill:
                Image(systemName: "sparkles").font(.system(size: 15)).foregroundStyle(Palette.ink2)
            case .tab(let tab):
                Image(systemName: TabWords.glyph(tab.kind)).font(.system(size: 15)).foregroundStyle(Palette.ink2)
            case .file(let file):
                Image(systemName: FileKind.symbol(file.rel)).font(.system(size: 15)).foregroundStyle(Palette.ink2)
            }
        } name: {
            Text(row.name).font(.body.weight(.medium))
        }
        .accessibilityLabel(row.name)
        .accessibilityHint(row.detail)
    }
}

/// One row's line: a mark in a fixed column, the name, and the quiet words after it, cut before the
/// name is.
private struct SuggestionLine<Mark: View, Name: View>: View {
    let active: Bool
    @ViewBuilder let mark: Mark
    @ViewBuilder let name: Name
    let detail: String
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var markColumn: CGFloat = 24

    init(active: Bool, detail: String, @ViewBuilder mark: () -> Mark, @ViewBuilder name: () -> Name) {
        self.active = active
        self.detail = detail
        self.mark = mark()
        self.name = name()
    }

    var body: some View {
        HStack(spacing: 12) {
            mark.frame(width: markColumn, height: markColumn)
            name
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .layoutPriority(1)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(Palette.ink3)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: height)
        .background(active ? Palette.hover : .clear)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
    }
}

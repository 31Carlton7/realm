import RealmKit
import SwiftUI

/// A pane picked into the composer as a card: the pane, and what the Mac said it comes to once it
/// has read it.
struct DraftTab: Identifiable, Hashable {
    let tab: SpaceTab
    var card: TabCard?

    var id: String { tab.itemId }

    /// As many as the Mac takes with one message.
    static let perMessage = 8

    /// Adds the pane's card unless it is there already or the message is full; whether it was added.
    static func add(_ tab: SpaceTab, to tabs: inout [DraftTab]) -> Bool {
        guard tabs.count < perMessage, !tabs.contains(where: { $0.id == tab.itemId }) else { return false }
        tabs.append(DraftTab(tab: tab))
        return true
    }

    /// The Mac's read of a card still in the draft.
    static func read(_ card: TabCard, into tabs: inout [DraftTab]) {
        guard let at = tabs.firstIndex(where: { $0.id == card.itemId }) else { return }
        tabs[at].card = card
    }
}

/// How the phone talks about a pane handed over as a card, as the desktop's `TabCards.tsx` does.
enum TabWords {
    static func glyph(_ kind: TabKind) -> String {
        switch kind {
        case .browser: PaneWords.browserGlyph
        case .documents: "doc.text"
        case .terminal: PaneWords.terminalGlyph
        case .simulator: "iphone"
        }
    }

    /// A card's second line: where the pane is and its size, once the Mac has read it. A pane gone
    /// when it was read says so instead.
    static func line(_ tab: SpaceTab, card: TabCard?) -> String {
        guard let card else { return tab.detail }
        if card.closed == true { return "Closed" }
        return "\(tab.detail) · \(ByteCountFormatter.string(fromByteCount: Int64(card.bytes), countStyle: .binary))"
    }

    /// The word a card cut to fit wears after its line, in the one warning ink.
    static func flag(_ card: TabCard?) -> String? {
        card?.truncated == true && card?.closed != true ? "Cut to fit" : nil
    }
}

/// One card: its kind's glyph, the pane's title, and its line under it.
struct TabChip: View {
    let tab: SpaceTab
    let card: TabCard?
    /// In the composer, where a tap takes it out: a quiet × says so.
    var removable = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: TabWords.glyph(tab.kind))
                .font(.body)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink2)
            VStack(alignment: .leading, spacing: 1) {
                Text(Mentions.tabName(tab))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                HStack(spacing: 0) {
                    Text(TabWords.line(tab, card: card)).foregroundStyle(Palette.ink2)
                    if let flag = TabWords.flag(card) {
                        Text(" · ").foregroundStyle(Palette.ink2)
                        Text(flag).foregroundStyle(Palette.orange)
                    }
                }
                .font(.caption)
                .lineLimit(1)
            }
            if removable {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: 220, minHeight: 44, alignment: .leading)
    }
}

/// The cards a sent message handed over, under its bubble.
struct SentTabs: View {
    let tabs: [TabCard]

    var body: some View {
        TrailingFlow(spacing: 6) {
            ForEach(tabs, id: \.itemId) { card in
                TabChip(tab: card.tab, card: card)
                    .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                    .accessibilityElement(children: .combine)
            }
        }
    }
}

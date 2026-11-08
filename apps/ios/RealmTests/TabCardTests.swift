import RealmKit
import Testing
@testable import Realm

@Suite("The tabs an @ hands a message, as cards beside the draft")
struct TabCardTests {
    static let pricing = SpaceTab(itemId: "i-b1", kind: .browser, title: "Pricing", url: "https://example.com/pricing")
    static let shell = SpaceTab(itemId: "i-t1", kind: .terminal, title: "zsh")

    @Test func aPaneIsCardedOnceAndAMessageTakesEight() {
        var tabs: [DraftTab] = []
        #expect(DraftTab.add(Self.pricing, to: &tabs))
        #expect(!DraftTab.add(Self.pricing, to: &tabs))
        for i in 2...8 { #expect(DraftTab.add(SpaceTab(itemId: "i-\(i)", kind: .browser, title: "Page \(i)"), to: &tabs)) }
        #expect(!DraftTab.add(Self.shell, to: &tabs))
        #expect(tabs.map(\.id).first == "i-b1" && tabs.count == 8)
    }

    @Test func aCardSaysWhereThePaneIsThenWhatItCameToOnceRead() {
        var tabs: [DraftTab] = []
        _ = DraftTab.add(Self.pricing, to: &tabs)
        #expect(TabWords.line(Self.pricing, card: tabs[0].card) == "example.com/pricing")
        DraftTab.read(TabCard(itemId: "i-b1", kind: .browser, title: "Pricing", bytes: 2048, truncated: true), into: &tabs)
        // A read for a card taken out meanwhile changes nothing.
        DraftTab.read(TabCard(itemId: "i-gone", kind: .browser, title: "Gone", bytes: 1, truncated: false), into: &tabs)
        #expect(tabs.count == 1)
        #expect(TabWords.line(Self.pricing, card: tabs[0].card) == "example.com/pricing · 2 KB")
        #expect(TabWords.flag(tabs[0].card) == "Cut to fit")
        let closed = TabCard(itemId: "i-t1", kind: .terminal, title: "zsh", bytes: 0, truncated: true, closed: true)
        #expect(TabWords.line(Self.shell, card: closed) == "Closed")
        #expect(TabWords.flag(closed) == nil)
    }

    @Test func aChipOfACollidingNameSaysWhereItRunsBesideItsSize() {
        let card = TabCard(itemId: "i-t1", kind: .terminal, title: "zsh", cwd: "~/a/realm", bytes: 2048, truncated: false)
        #expect(card.tab.cwd == "~/a/realm")
        #expect(TabWords.line(Self.shell, detail: "~/a/realm", card: nil) == "~/a/realm")
        #expect(TabWords.line(Self.shell, detail: "~/a/realm", card: card) == "~/a/realm · 2 KB")
        #expect(TabWords.line(Self.shell, card: card) == "Terminal · 2 KB")
    }

    @Test func eachKindHasItsGlyph() {
        #expect(TabKind.allCases.map(TabWords.glyph) == ["globe", "doc.text", "terminal", "iphone"])
    }

    @Test func aMessageOfTabsAloneCanBeSent() {
        #expect(ComposerAction.hasContent(text: " ", attachments: [], tabs: 1))
        #expect(!ComposerAction.hasContent(text: " ", attachments: [], tabs: 0))
    }
}

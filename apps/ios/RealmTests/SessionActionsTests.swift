import Foundation
import RealmKit
import Testing
@testable import Realm

extension SessionRow {
    /// The row, pinned.
    var pinnedRow: SessionRow {
        var row = self
        row.pinned = true
        return row
    }
}

@MainActor
@Suite("A rename, a pin or an archive, before and after the Mac has it")
struct RowEditsTests {
    static let row = Staged.relay

    @Test func aChangeShowsAtOnceOverWhatTheMacLists() {
        var edits = RowEdits()
        _ = edits.begin(.title("Explain the relay to a new hire"), on: "relay")
        _ = edits.begin(.pinned(true), on: "relay")
        let shown = edits.applied(to: Self.row)
        #expect(shown?.title == "Explain the relay to a new hire" && shown?.pinned == true)
        #expect(edits.applied(to: Staged.mapper) == Staged.mapper, "another session is as the Mac lists it")
        _ = edits.begin(.archived(true), on: "relay")
        #expect(edits.applied(to: Self.row) == nil)
    }

    /// Refused, the row is as the Mac lists it; a later change to the same field stays where it is.
    @Test func aRefusalPutsTheRowBackUnlessALaterChangeTookItsPlace() {
        var edits = RowEdits()
        let pin = edits.begin(.pinned(true), on: "relay")
        edits.refused(pin, on: "relay")
        #expect(edits.applied(to: Self.row) == Self.row)
        let first = edits.begin(.pinned(true), on: "relay")
        _ = edits.begin(.pinned(false), on: "relay")
        edits.refused(first, on: "relay")
        #expect(edits.applied(to: Self.row)?.pinned == false)
        let rename = edits.begin(.title("Kept"), on: "relay")
        edits.refused(pin, on: "relay")
        #expect(edits.applied(to: Self.row)?.title == "Kept", "an old token settles nothing")
        edits.refused(rename, on: "relay")
        #expect(edits.applied(to: Self.row)?.title == Self.row.title)
    }

    /// Taken, a change stays until a Home asked for after it lists the session: one already on its way
    /// may have been read before the change.
    @Test func aTakenChangeStaysUntilAHomeAskedAfterItListsTheSession() {
        var edits = RowEdits()
        let rename = edits.begin(.title("Explain the relay to a new hire"), on: "relay")
        edits.caughtUp(with: Staged.home, ask: 40)
        #expect(edits.applied(to: Self.row)?.title == "Explain the relay to a new hire", "on its way, it outlasts every Home")
        edits.taken(rename, on: "relay", ask: 3)
        edits.caughtUp(with: Staged.home, ask: 3)
        #expect(edits.applied(to: Self.row)?.title == "Explain the relay to a new hire", "that Home was asked for before")
        // The Mac lists it the new way, or someone renamed it since: either way the Mac's word stands.
        edits.caughtUp(with: Staged.home, ask: 4)
        #expect(edits.applied(to: Self.row) == Self.row)
    }

    /// A session the Mac no longer lists keeps the change: archived, it stays gone; listed again, it was
    /// put back, on the Mac or here.
    @Test func anArchiveHoldsWhileTheMacListsTheSessionNoMore() {
        var edits = RowEdits()
        let archive = edits.begin(.archived(true), on: "relay")
        edits.taken(archive, on: "relay", ask: 2)
        let without = Staged.with(spaces: Staged.spaces.map { space in
            Space(id: space.id, name: space.name, icon: space.icon, color: space.color, sessions: space.sessions.filter { $0.id != "relay" },
                  more: space.more, profileId: space.profileId)
        }, recent: .some(Staged.home.recent?.filter { $0.id != "relay" }))
        edits.caughtUp(with: without, ask: 3)
        #expect(edits.applied(to: Self.row) == nil)
        edits.caughtUp(with: Staged.home, ask: 4)
        #expect(edits.applied(to: Self.row) == Self.row)
    }

    /// Home comes back with every row as changed, wherever it is listed, and without what was archived.
    @Test func homeListsEveryRowAsChanged() {
        var edits = RowEdits()
        #expect(edits.applied(to: Staged.home) == Staged.home)
        _ = edits.begin(.title("The toggle"), on: "toggle")
        _ = edits.begin(.archived(true), on: "mapper")
        let home = edits.applied(to: Staged.home)
        #expect(home.needsYou.first { $0.id == "toggle" }?.title == "The toggle")
        #expect(home.spaces[0].sessions.map(\.title) == ["The toggle", "Explain the relay"])
        #expect(home.recent?.contains { $0.id == "mapper" } == false)
        #expect(home.spaces[0].more == 4 && home.spaces[0].emoji == "🌊" && home.profiles == Staged.home.profiles)
    }

    @Test func eachChangeSaysWhatItSendsAndWhatARefusalMeans() {
        #expect(RowChange.title("A").title == "A" && RowChange.title("A").pinned == nil && RowChange.title("A").archived == nil)
        #expect(RowChange.pinned(false).pinned == false && RowChange.archived(true).archived == true)
        #expect([RowChange.title("A"), .pinned(true), .pinned(false), .archived(true), .archived(false)].map(\.refusal)
                == ["Not renamed.", "Not pinned.", "Not unpinned.", "Not archived.", "Not put back."])
    }

    /// Rename sends the title trimmed, and nothing while it is empty or as it was.
    @Test func aRenameSendsOnlyANewTitle() {
        var draft = RenameDraft(row: Self.row)
        #expect(draft.title == "Explain the relay" && draft.change == nil)
        draft.title = "  \n "
        #expect(draft.change == nil)
        draft.title = " Explain the relay "
        #expect(draft.change == nil)
        draft.title = "  How the relay works\n"
        #expect(draft.change == "How the relay works")
        draft.title = String(repeating: "a", count: 250)
        #expect(draft.change?.count == 200, "no longer than the Mac keeps")
    }
}

@MainActor
@Suite("What a session's row offers")
struct RowActionsTests {
    @Test func atRestItPinsRenamesAndArchives() {
        let actions = RowActions(row: Staged.relay, connected: true)
        #expect(actions.leading == [.pin])
        #expect(actions.trailing == [.archive, .rename])
        #expect(actions.menu == [.pin, .rename, .archive])
        #expect(actions.menu.allSatisfy { !actions.isOff($0) })
    }

    /// Pinned, it unpins; while a turn runs or waits on the person, Stop comes last.
    @Test func pinnedItUnpinsAndWorkingItStops() {
        let actions = RowActions(row: Staged.toggle.pinnedRow, connected: true)
        #expect(actions.leading == [.unpin])
        #expect(actions.trailing == [.archive, .rename, .stop])
        #expect(actions.menu == [.unpin, .rename, .archive, .stop])
    }

    /// Away from the Mac what changes its row is off; Stop keeps its place, and says why it cannot go.
    @Test func awayFromTheMacOnlyStopStaysOn() {
        let actions = RowActions(row: Staged.toggle, connected: false)
        #expect([RowAction.pin, .rename, .archive].allSatisfy(actions.isOff))
        #expect(!actions.isOff(.stop))
    }

    @Test func eachSaysWhatItDoes() {
        let all: [RowAction] = [.pin, .unpin, .rename, .archive, .stop]
        #expect(all.map(\.title) == ["Pin", "Unpin", "Rename", "Archive", "Stop"])
        #expect(all.map(\.symbol) == ["pin", "pin.slash", "pencil", "archivebox", "stop.fill"])
    }
}

@MainActor
@Suite("Pinned, at the head of Home")
struct PinnedSectionTests {
    /// Realm's relay and Thesis's reading pinned, and Site's database, which waits on the person.
    static let home = Staged.with(
        spaces: [
            Space(id: "realm", name: "Realm", icon: "emoji:🌊", color: "#3b82f6", sessions: [Staged.toggle, Staged.relay.pinnedRow, Staged.mapper],
                  more: 4, profileId: "work"),
            Space(id: "site", name: "Site", icon: "rocket", color: "#10b981", sessions: [Staged.database.pinnedRow], more: 0, profileId: "work"),
            Staged.spaces[2],
            Space(id: "thesis", name: "Thesis", icon: "book", color: "", sessions: [Staged.essay, Staged.notes, Staged.reading.pinnedRow],
                  more: 0, profileId: "school"),
        ],
        needsYou: [Staged.essay, Staged.database.pinnedRow, Staged.toggle, Staged.notes],
        recent: .some([Staged.toggle, Staged.database.pinnedRow, Staged.relay.pinnedRow, Staged.mapper, Staged.older.pinnedRow, Staged.oldest]))

    /// The chosen profile's pinned sessions, once each, in the order of their spaces on the Mac and then
    /// the newest activity first, in every list style.
    @Test func pinnedHeadsHomeInEveryStyle() {
        for style in ListStyle.allCases {
            let listing = Staged.listing(Self.home, style: style)
            #expect(listing.pinned.map(\.id) == ["relay", "older", "database"], "\(style)")
        }
        #expect(Staged.listing(Self.home, .profile("school")).pinned.map(\.id) == ["reading"])
        #expect(Staged.listing(Self.home, .all).pinned.map(\.id) == ["relay", "older", "database", "reading"])
    }

    /// Pinned is a way to a session, as on the Mac: each is still listed where the style puts it.
    @Test func aPinnedSessionStaysWhereTheListPutsItToo() {
        #expect(Staged.listing(Self.home).ids.first == ["toggle", "relay", "mapper"])
        #expect(Staged.listing(Self.home, style: .mostRecent).ids.first?.contains("relay") == true)
        #expect(Staged.listing(Self.home).needsYou.map(\.id).contains("database"), "Needs you still lists what waits")
    }

    @Test func aSearchNarrowsPinnedAndNothingPinnedIsNoSection() {
        #expect(Staged.listing(Self.home, query: "relay").pinned.map(\.id) == ["relay"])
        #expect(Staged.listing(Self.home, query: "nothing like it").pinned.isEmpty)
        #expect(Staged.listing().pinned.isEmpty)
        let onlyPinned = Staged.with(spaces: [Space(id: "realm", name: "Realm", icon: nil, color: nil, sessions: [], more: 0, profileId: "work")],
                                     needsYou: [], recent: .some([Staged.relay.pinnedRow]))
        let listing = Staged.listing(onlyPinned, style: .bySpace)
        #expect(listing.sections.isEmpty && !listing.isEmpty, "a list of pins alone is not an empty Home")
    }
}

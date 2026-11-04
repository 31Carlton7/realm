import Foundation
import RealmKit
import Testing
@testable import Realm

@MainActor
@Suite("Home's Team")
struct TeamTests {
    static func teammate(_ id: String, space: String = "realm", lead: Bool = false, state: TeammateState? = .idle,
                         unread: Bool = false, chat: String? = nil) -> Teammate {
        Teammate(id: id, spaceId: space, name: id.capitalized, handle: id, brief: "", lead: lead, chatId: chat,
                 icon: TeammateIcon(shape: "circle", color: "blue"), state: state, unread: unread,
                 agentKind: "claude", model: "claude-opus-5-5", permissionMode: "default")
    }

    @Test func aTeamIsTheProfilesSpacesTeammatesInTheMacsOrder() {
        let team = [Self.teammate("cto", lead: true), Self.teammate("tutor", space: "thesis"), Self.teammate("designer", space: "site")]
        #expect(TeamListing.teammates(team, in: Staged.home, choice: .profile("work")).map(\.id) == ["cto", "designer"])
        #expect(TeamListing.teammates(team, in: Staged.home, choice: .profile("school")).map(\.id) == ["tutor"])
        #expect(TeamListing.spaces(of: team, in: Staged.home).map(\.id) == ["realm", "site", "thesis"])
    }

    /// A short team is listed whole; a long one, its Lead and whoever is working, waiting or unread, in
    /// the team's own order, so no row jumps when a state changes.
    @Test func aLongTeamShowsItsLeadAndItsBusyOnes() {
        let short = (1...6).map { Self.teammate("t\($0)") }
        #expect(TeamSection.shown(short).count == 6)
        let long = [Self.teammate("cto", lead: true)] + (1...8).map { Self.teammate("t\($0)") }
            + [Self.teammate("qa", state: .needsYou), Self.teammate("writer", unread: true), Self.teammate("designer", state: .working)]
        #expect(TeamSection.shown(long).map(\.id) == ["cto", "qa", "writer", "designer"])
    }

    /// A teammate's chat is listed once, as the teammate, except where Needs you says it waits, and in a
    /// search, where the Team is not shown.
    @Test func aTeammatesChatIsNotListedAgainAsASession() {
        let chats: Set<String> = ["relay", "toggle"]
        let bySpace = HomeListing(home: Staged.home, choice: .profile("work"), teamChats: chats)
        #expect(bySpace.ids == [["mapper"], ["database"]])
        #expect(bySpace.needsYou.map(\.id).contains("toggle"))
        let recent = HomeListing(home: Staged.home, choice: .profile("work"), options: ListOptions(style: .mostRecent), teamChats: chats)
        #expect(!recent.ids.joined().contains("relay"))
        let searched = HomeListing(home: Staged.home, choice: .profile("work"), query: "relay", teamChats: chats)
        #expect(searched.ids.joined().contains("relay"))
    }

    /// Save sends what changed: an icon as both its parts, another agent with its model back to its
    /// default, and a name without the spaces round it.
    @Test func anEditSendsOnlyWhatChanged() {
        let start = TeammateDraft(Self.teammate("designer"))
        var draft = start
        #expect(draft.edit(from: start).isEmpty)
        draft.name = "  Design lead "
        draft.color = "pink"
        #expect(draft.edit(from: start) == TeammateEdit(name: "Design lead", icon: TeammateIcon(shape: "circle", color: "pink")))
        draft = start
        draft.agentKind = "codex"
        draft.model = nil
        draft.lead = true
        draft.permissionMode = "acceptEdits"
        #expect(draft.edit(from: start) == TeammateEdit(agentKind: "codex", model: .some(nil), permissionMode: "acceptEdits", lead: true))
    }

    /// A teammate, and a message to one, wear amber only while it needs you.
    @Test func aTeammateIsAmberOnlyWhileItNeedsYou() {
        #expect(TeammateState.needsYou.tone == .waiting && TeammateState.working.tone == .working && TeammateState.idle.tone == .quiet)
        #expect(TeammateCallState.needsYou.tone == .waiting && TeammateCallState.working.tone == .working && TeammateCallState.done.tone == .done)
    }
}

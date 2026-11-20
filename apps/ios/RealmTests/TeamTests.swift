import Foundation
import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

@MainActor
@Suite("Home's Team", .serialized)
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
    }

    /// Home's row leads with the Leads, then each space's Team in its own order, the spaces as Home lists
    /// them; a profile with no teammates has none.
    @Test func theRowLeadsWithTheLeadThenEachSpacesTeam() {
        let team = [Self.teammate("designer", space: "site"), Self.teammate("cto", lead: true), Self.teammate("qa"),
                    Self.teammate("web", space: "site", lead: true), Self.teammate("tutor", space: "thesis")]
        #expect(TeamListing.row(team, in: Staged.home, choice: .profile("work")).map(\.id) == ["cto", "web", "qa", "designer"])
        #expect(TeamListing.row(team, in: Staged.home, choice: .profile("school")).map(\.id) == ["tutor"])
        #expect(TeamListing.row(team.filter { $0.spaceId != "thesis" }, in: Staged.home, choice: .profile("school")).isEmpty)
    }

    /// The row draws every teammate's name, a long team whole for the sideways scroll, and nothing at all
    /// for a profile with none.
    @Test func theRowDrawsItsTeamAndNothingWhenEmpty() throws {
        let model = AppModel()
        let row = [Self.teammate("mira", lead: true), Self.teammate("otis"), Self.teammate("juno")]
        let words = try Drawing.words(TeamRow(teammates: row).environment(model))
        #expect(words.contains("Mira") && words.contains("Otis") && words.contains("Juno"), "\(words)")
        #expect(try #require(words.range(of: "Mira")).lowerBound < (try #require(words.range(of: "Juno"))).lowerBound, "\(words)")
        func height(_ team: [Teammate]) -> CGFloat {
            UIHostingController(rootView: TeamRow(teammates: team).environment(model))
                .sizeThatFits(in: CGSize(width: 390, height: 1_000)).height
        }
        #expect(height([]) == 0 && height(row) > 60, "\(height([])) \(height(row))")
    }

    /// A mark in the row says how its teammate stands as its row does: the dot while it works or needs
    /// you, the name bold while its chat is unread, and nothing extra while it is idle and read.
    @Test func aMarkShowsItsTeammatesState() throws {
        let model = AppModel()
        func drawn(_ teammate: Teammate) throws -> [UInt8] {
            let image = try #require(Drawing.image(of: TeammateAvatar(teammate: teammate).environment(model), width: 100, dark: false).cgImage)
            var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let context = try #require(CGContext(data: &pixels, width: image.width, height: image.height, bitsPerComponent: 8,
                                                 bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return pixels
        }
        /// How many pixels of two drawings of one size differ visibly.
        func changed(_ a: [UInt8], _ b: [UInt8]) -> Int {
            guard a.count == b.count else { return .max }
            return stride(from: 0, to: a.count, by: 4).count { i in (0..<3).contains { abs(Int(a[i + $0]) - Int(b[i + $0])) > 48 } }
        }
        _ = try drawn(Self.teammate("otis"))
        let idle = try drawn(Self.teammate("otis"))
        #expect(changed(try drawn(Self.teammate("otis")), idle) < 10)
        #expect(changed(try drawn(Self.teammate("otis", state: .working)), idle) > 40)
        #expect(changed(try drawn(Self.teammate("otis", state: .needsYou)), idle) > 40)
        #expect(changed(try drawn(Self.teammate("otis", unread: true)), idle) > 40)
        #expect(TeammateWords.spoken(Self.teammate("otis", state: .needsYou, unread: true)) == "Otis, Needs you, Unread")
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

    /// A new teammate starts as the Mac's sheet starts one: the agent last used, on the model last sent
    /// on with it where that is still offered, in the permission new sessions start in.
    @Test func aNewTeammateStartsOnTheMacsDefaults() {
        let agents = [NewSessionTests.agent("claude", "Claude"), NewSessionTests.agent("codex", "Codex")]
        let list = AgentList(agents: agents, defaultAgent: "codex", midTurn: .queue, attachments: NewSessionTests.limits,
                             lastModels: ["codex": "claude-sonnet-5", "claude": nil], teammatePermission: "acceptEdits")
        let draft = TeammateDraft(agents: list)
        #expect(draft.agentKind == "codex" && draft.model == "claude-sonnet-5" && draft.permissionMode == "acceptEdits")
        #expect(draft.name.isEmpty && !draft.lead)
        let gone = AgentList(agents: agents, defaultAgent: "codex", midTurn: .queue, attachments: NewSessionTests.limits,
                             lastModels: ["codex": "gpt-4"])
        #expect(TeammateDraft(agents: gone).model == nil && TeammateDraft(agents: gone).permissionMode == "default")
    }

    /// A drag that would put another teammate above the Lead, or that moved nothing, is not sent.
    @Test func aDragKeepsTheLeadOnTop() {
        let team = [Self.teammate("cto", lead: true), Self.teammate("designer"), Self.teammate("qa")]
        #expect(TeamOrder.moved(team, from: [2], to: 1)?.map(\.id) == ["cto", "qa", "designer"])
        #expect(TeamOrder.moved(team, from: [1], to: 0) == nil)
        #expect(TeamOrder.moved(team, from: [1], to: 1) == nil)
    }

    /// A space's Team as the Mac answers it takes that space's place in the list, the others untouched.
    @Test func aSpacesNewTeamTakesItsPlace() {
        let list = [Self.teammate("cto", lead: true), Self.teammate("designer"), Self.teammate("tutor", space: "thesis")]
        let led = [Self.teammate("designer", lead: true), Self.teammate("cto")]
        #expect(WorkModel.replacing("realm", with: led, in: list).map(\.id) == ["designer", "cto", "tutor"])
        #expect(WorkModel.replacing("site", with: [Self.teammate("web", space: "site")], in: list).map(\.id) == ["cto", "designer", "tutor", "web"])
    }
}

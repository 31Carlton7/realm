import Foundation
@testable import RealmKit
import Testing

/// Home's half of Plan 29 as the Mac writes it (`packages/remote/test/fixtures/ts-api.json`): the
/// profiles and their spaces, the recent list for every profile and for one, and a space's sessions a
/// page at a time.
@Suite("Home's profiles and pages as the Mac writes them")
struct HomeFixtureTests {
    static let available = APIFixtureTests.available

    static func home(_ key: String = "home.get") throws -> Home { try APIFixtureTests.decode(Home.self, "calls", key) }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func homeNamesTheProfilesInTheMacsOrderWithWhatNeedsYouInEach() throws {
        let home = try Self.home()
        let profiles = try #require(home.profiles)
        #expect(profiles.map(\.name) == ["Work", "School"])
        #expect(profiles.map(\.needsYou) == [2, 0])
        #expect(profiles[0].iconKind == .glyph && profiles[0].glyph != nil)
        #expect(profiles[1].iconKind == .emoji && profiles[1].emoji == "🎓")
        // Every space says whose it is, and each profile's count is Needs you's rows in its spaces.
        #expect(home.spaces.map(\.profileId) == ["p1", "p1", "p2"])
        let workSpaces = Set(home.spaces.filter { $0.profileId == "p1" }.map(\.id))
        #expect(home.needsYou.filter { workSpaces.contains($0.spaceId) }.count == profiles[0].needsYou)
        #expect(home.needsYou.count == profiles.map(\.needsYou).reduce(0, +))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func everyProfilesRecentListIsNewestFirstAndReachesPastEachSpacesFew() throws {
        let home = try Self.home()
        #expect(home.profileId == nil, "asked for no profile, gathered for every one")
        let recent = try #require(home.recent)
        #expect(recent.map(\.lastActivity) == recent.map(\.lastActivity).sorted(by: >))
        // A session set up anew since its conversation last moved has the newest change, and keeps the
        // place its conversation gives it.
        let release = try #require(recent.first { $0.title == "Plan the release" })
        #expect(release.updatedAt > release.lastActivity)
        #expect(recent.first?.id != release.id)
        #expect(Set(recent.map(\.spaceId)) == Set(home.spaces.map(\.id)))
        let onHome = Set(home.spaces.flatMap(\.sessions).map(\.id))
        #expect(recent.contains { !onHome.contains($0.id) }, "a session older than its space's newest few")
        // Each row says when it was made and how it was set up.
        #expect(recent.allSatisfy { $0.createdAt != nil && $0.permissionMode != nil })
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func oneProfilesRecentListIsOnlyItsOwn() throws {
        let home = try Self.home("home.get:profile")
        #expect(home.profileId == "p1")
        let recent = try #require(home.recent)
        let mine = Set(home.spaces.filter { $0.profileId == "p1" }.map(\.id))
        #expect(!recent.isEmpty && recent.allSatisfy { mine.contains($0.spaceId) })
        // Spaces and Needs you are still every profile's.
        #expect(home.spaces.count == 3)
        #expect(try Self.home().recent?.filter { mine.contains($0.spaceId) }.map(\.id) == recent.map(\.id))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSpacesPagesFollowOnAndSayWhenTheyEnd() throws {
        let first = try APIFixtureTests.decode(SpaceSessions.self, "calls", "space.sessions")
        let last = try APIFixtureTests.decode(SpaceSessions.self, "calls", "space.sessions:last")
        #expect(first.more && !last.more)
        let rows = first.sessions + last.sessions
        #expect(Set(rows.map(\.id)).count == rows.count, "no session on two pages")
        #expect(rows.allSatisfy { $0.spaceId == "sp1" })
        #expect(rows.map(\.lastActivity) == rows.map(\.lastActivity).sorted(by: >))
        // Home's few are the first of them, and the rest are what it says it left out.
        let realm = try #require(try Self.home().spaces.first { $0.id == "sp1" })
        #expect(Array(rows.prefix(realm.sessions.count)).map(\.id) == realm.sessions.map(\.id))
        #expect(rows.count == realm.sessions.count + realm.more)
    }
}

import Foundation
import RealmKit
import Testing
@testable import Realm

/// A Mac with three profiles, as Plan 29's `home.get` sends it: Work with two spaces and one with no
/// sessions, School with one, Personal with none. Needs you is every profile's, in the Mac's order.
enum Staged {
    /// A session as a row: `at` is its last change, and its activity too unless `activity` says otherwise.
    static func row(_ id: String, space: String, spaceName: String, status: SessionStatus = .idle, at updatedAt: Millis,
                    activity: Millis? = nil, agent: String = "claude", title: String? = nil) -> SessionRow {
        SessionRow(id: id, title: title ?? id, spaceId: space, spaceName: spaceName, agent: agent, model: nil, status: status,
                   needsYou: status == .waiting || status == .error, unread: false, updatedAt: updatedAt, activityAt: activity)
    }

    static let toggle = row("toggle", space: "realm", spaceName: "Realm", status: .waiting, at: 100, title: "Add the dark-mode toggle")
    static let relay = row("relay", space: "realm", spaceName: "Realm", at: 90, title: "Explain the relay")
    static let mapper = row("mapper", space: "realm", spaceName: "Realm", at: 80, title: "Rework the transcript mapper")
    static let older = row("older", space: "realm", spaceName: "Realm", at: 40, title: "Ship 2.0.3")
    static let oldest = row("oldest", space: "realm", spaceName: "Realm", at: 30, title: "Audit the sign-in sheet")
    static let database = row("database", space: "site", spaceName: "Site", status: .waiting, at: 95, agent: "codex",
                              title: "Choose the database")
    static let essay = row("essay", space: "thesis", spaceName: "Thesis", status: .waiting, at: 70, title: "Outline the essay")
    static let notes = row("notes", space: "thesis", spaceName: "Thesis", status: .error, at: 60, title: "Clean the lecture notes")
    static let reading = row("reading", space: "thesis", spaceName: "Thesis", at: 50, title: "Summarise the reading")

    static let profiles = [
        Profile(id: "work", name: "Work", icon: "emoji:🛠️", iconKind: .emoji, emoji: "🛠️", needsYou: 2),
        Profile(id: "school", name: "School", icon: "book", iconKind: .glyph, glyph: "book", needsYou: 2),
        Profile(id: "personal", name: "Personal", icon: "", needsYou: 0),
    ]

    static let spaces = [
        Space(id: "realm", name: "Realm", icon: "emoji:🌊", color: "#3b82f6", sessions: [toggle, relay, mapper], more: 4, profileId: "work"),
        Space(id: "site", name: "Site", icon: "rocket", color: "#10b981", sessions: [database], more: 0, profileId: "work"),
        Space(id: "empty", name: "Empty", icon: "folder", color: "", sessions: [], more: 0, profileId: "work"),
        Space(id: "thesis", name: "Thesis", icon: "book", color: "", sessions: [essay, notes, reading], more: 0, profileId: "school"),
    ]

    /// Waiting first, the longest waiting first; then what failed.
    static let needsYou = [essay, database, toggle, notes]

    /// Home as asked for Work: its recent sessions, newest first, two of them older than Realm's three.
    static let home = Home(mac: MacInfo(name: "MacBook Pro"), needsYou: needsYou, spaces: spaces, profiles: profiles,
                           profileId: "work", recent: [toggle, database, relay, mapper, older, oldest])

    /// The same Mac before Plan 29: no profiles, no recent list, spaces that belong to none.
    static let olderHome = Home(mac: MacInfo(name: "MacBook Pro"), needsYou: needsYou, spaces: spaces.map { space in
        Space(id: space.id, name: space.name, icon: space.icon, color: space.color, sessions: space.sessions, more: space.more)
    })

    static func with(spaces: [Space]? = nil, needsYou: [SessionRow]? = nil, profiles: [Profile]?? = .none,
                     profileId: String?? = .none, recent: [SessionRow]?? = .none) -> Home {
        Home(mac: home.mac, needsYou: needsYou ?? home.needsYou, spaces: spaces ?? home.spaces,
             profiles: profiles ?? home.profiles, profileId: profileId ?? home.profileId, recent: recent ?? home.recent)
    }

    static func listing(_ home: Home = home, _ choice: ProfileChoice = .profile("work"), style: ListStyle = .bySpace,
                        order: SpaceOrder = .asOnMac, needsYouFirst: Bool = true, query: String = "") -> HomeListing {
        HomeListing(home: home, choice: choice, options: ListOptions(style: style, spaceOrder: order, needsYouFirst: needsYouFirst),
                    query: query)
    }
}

extension HomeListing {
    var ids: [[String]] { sections.map { $0.rows.map(\.id) } }
    var heads: [String] {
        sections.map { section in
            switch section.head {
            case .space(let space): space.id
            case .day(let day): day.title
            case .recent: "recent"
            }
        }
    }
}

@MainActor
@Suite("The profile Home shows")
struct ProfileChoiceTests {
    @Test func aChoiceIsKeptAsWordsAndReadBack() {
        #expect(ProfileChoice.all.stored == "all")
        #expect(ProfileChoice.profile("01JWORK").stored == "profile:01JWORK")
        #expect(ProfileChoice(stored: "all") == .all)
        #expect(ProfileChoice(stored: "profile:01JWORK") == .profile("01JWORK"))
        // An id that reads like the word for every profile is still a profile.
        #expect(ProfileChoice(stored: "profile:all") == .profile("all"))
        #expect(ProfileChoice(stored: "profile:") == nil)
        #expect(ProfileChoice(stored: "Work") == nil)
        #expect(ProfileChoice(stored: "") == nil)
    }

    @Test func nothingChosenShowsTheFirstProfile() {
        #expect(ProfileChoice.resolve(nil, in: Staged.home) == .profile("work"))
    }

    @Test func theChosenProfileIsShownWhileTheMacHasIt() {
        #expect(ProfileChoice.resolve(.profile("school"), in: Staged.home) == .profile("school"))
        #expect(ProfileChoice.resolve(.all, in: Staged.home) == .all)
        // Gone from the Mac, or left with no spaces, as the Mac's own sidebar would not offer it.
        #expect(ProfileChoice.resolve(.profile("deleted"), in: Staged.home) == .profile("work"))
        #expect(ProfileChoice.resolve(.profile("personal"), in: Staged.home) == .profile("work"))
    }

    @Test func theFirstProfileWithASpaceIsTheDefault() {
        let home = Staged.with(profiles: [Staged.profiles[2], Staged.profiles[1], Staged.profiles[0]])
        #expect(ProfileChoice.resolve(nil, in: home) == .profile("school"))
        // With no spaces anywhere, the first.
        #expect(ProfileChoice.resolve(nil, in: Staged.with(spaces: [])) == .profile("work"))
    }

    @Test func aMacWithOneProfileOrTooOldToSayShowsEverything() {
        #expect(ProfileChoice.resolve(.profile("work"), in: Staged.olderHome) == .all)
        #expect(ProfileChoice.resolve(nil, in: Staged.with(profiles: .some([Staged.profiles[0]]))) == .all)
        #expect(ProfileChoice.resolve(.profile("work"), in: Staged.with(profiles: .some([]))) == .all)
    }

    @Test func theTitleIsTheProfilesName() {
        #expect(ProfileChoice.profile("school").title(in: Staged.home) == "School")
        #expect(ProfileChoice.all.title(in: Staged.home) == "All profiles")
        // Nothing to switch, or not known yet: what Home was called before profiles.
        #expect(ProfileChoice.all.title(in: Staged.olderHome) == "Sessions")
        #expect(ProfileChoice.profile("work").title(in: nil) == "Sessions")
        #expect(ProfileChoice.profile("work").title(in: Staged.with(profiles: .some([Staged.profiles[0]]))) == "Sessions")
    }

    @Test func anEmptyListSaysWhereItLooked() {
        #expect(ProfileChoice.profile("school").emptyWords(in: Staged.home) == "No sessions in School yet")
        #expect(ProfileChoice.all.emptyWords(in: Staged.home) == "No sessions yet")
        #expect(ProfileChoice.all.emptyWords(in: Staged.olderHome) == "No sessions yet")
        #expect(ProfileChoice.profile("gone").emptyWords(in: Staged.home) == "No sessions yet")
    }

    @Test func aProfilesMarkIsItsGlyphItsEmojiOrAPerson() {
        let person = ProfileMark.symbol("person.crop.circle")
        #expect(ProfileMark(Staged.profiles[0]) == .emoji("🛠️"))
        #expect(ProfileMark(Staged.profiles[1]) == .glyph("book"))
        #expect(ProfileMark(Staged.profiles[2]) == person)
        // The profile picker's own glyphs that no space has: a new profile's person, and code.
        #expect(ProfileMark(Profile(id: "p", name: "P", iconKind: .glyph, glyph: "user")) == person)
        #expect(ProfileMark(Profile(id: "p", name: "P", iconKind: .glyph, glyph: "code")) == .symbol("chevron.left.forwardslash.chevron.right"))
        #expect(ProfileMark(Profile(id: "p", name: "P", iconKind: .glyph, glyph: "briefcase-01")) == person)
        #expect(ProfileMark(Profile(id: "p", name: "P", iconKind: .picture)) == person)
        #expect(ProfileMark(Profile(id: "p", name: "P", iconKind: .emoji)) == person)
        // Every glyph the Mac's profile picker offers is drawn as itself or as the system's nearest.
        for glyph in ["user", "briefcase", "cap", "home", "code", "heart", "star", "book"] {
            let mark = ProfileMark(Profile(id: "p", name: "P", iconKind: .glyph, glyph: glyph))
            #expect(mark == .glyph(glyph) || mark == ProfileMark.symbols[glyph].map(ProfileMark.symbol), "\(glyph)")
        }
    }
}

@MainActor
@Suite("Home lists one profile at a time")
struct ProfileScopeTests {
    @Test func aProfileListsOnlyWhatIsInItsSpaces() {
        let work = Staged.listing()
        #expect(work.needsYou.map(\.id) == ["database", "toggle"], "the Mac's order, School's left out")
        #expect(work.heads == ["realm", "site"])
        let school = Staged.listing(Staged.home, .profile("school"))
        #expect(school.needsYou.map(\.id) == ["essay", "notes"])
        #expect(school.heads == ["thesis"])
    }

    @Test func allProfilesListEverything() {
        let all = Staged.listing(Staged.home, .all)
        #expect(all.needsYou.map(\.id) == ["essay", "database", "toggle", "notes"])
        #expect(all.heads == ["realm", "site", "thesis"])
        #expect(all.elsewhere.isEmpty)
    }

    /// An older Mac's Home is today's: every space, every session Needs you lists.
    @Test func anOlderMacsHomeListsEverything() {
        let older = Staged.listing(Staged.olderHome, .all)
        #expect(older.needsYou.count == 4)
        #expect(older.heads == ["realm", "site", "thesis"])
        #expect(older.sections.first?.more == 4)
        #expect(older.elsewhere.isEmpty)
    }

    @Test func aProfileWithNoSpacesListsNothing() {
        let personal = Staged.listing(Staged.home, .profile("personal"))
        #expect(personal.isEmpty)
        #expect(personal.elsewhere.map(\.id) == ["work", "school"])
        for style in ListStyle.allCases {
            #expect(Staged.listing(Staged.home, .profile("personal"), style: style).isEmpty, "\(style)")
        }
    }

    /// What needs the person in another profile is a line at the head of the list, in the Mac's order.
    @Test func whatNeedsYouElsewhereIsSaid() {
        let work = Staged.listing()
        #expect(work.elsewhere == [ProfileWaiting(profile: Staged.profiles[1], count: 2)])
        #expect(work.elsewhere.first?.words == "2 need you in School")
        #expect(Staged.listing(Staged.home, .profile("school")).elsewhere.map(\.words) == ["2 need you in Work"])
        // A search lists only what matched.
        #expect(Staged.listing(query: "relay").elsewhere.isEmpty)
        // Nothing waiting anywhere else, nothing said.
        let quiet = Staged.with(needsYou: [Staged.database])
        #expect(Staged.listing(quiet).elsewhere.isEmpty)
    }

    @Test func eachProfileCountsWhatNeedsYouInIt() {
        #expect(HomeListing.needing(Staged.home) == ["work": 2, "school": 2])
        #expect(HomeListing.needing(Staged.olderHome).isEmpty)
        #expect(ProfileWaiting.count(1) == "1 needs you")
        #expect(ProfileWaiting.count(2) == "2 need you")
        #expect(ProfileWaiting(profile: Staged.profiles[1], count: 1).words == "1 needs you in School")
    }

    @Test func aSearchSearchesOnlyTheProfileShown() {
        #expect(Staged.listing(query: "essay").isEmpty)
        #expect(Staged.listing(Staged.home, .profile("school"), query: "essay").needsYou.map(\.id) == ["essay"])
        #expect(Staged.listing(Staged.home, .all, query: "essay").needsYou.map(\.id) == ["essay"])
    }
}

@MainActor
@Suite("By space")
struct BySpaceTests {
    @Test func aSpaceWithNoSessionsIsLeftOut() {
        #expect(!Staged.listing().heads.contains("empty"))
        #expect(!Staged.listing(Staged.home, .all).heads.contains("empty"))
    }

    @Test func spacesAreInTheMacsOrderOrBySpacesNewestSession() {
        let site = Staged.row("site-new", space: "site", spaceName: "Site", at: 120)
        var spaces = Staged.spaces
        spaces[1] = Space(id: "site", name: "Site", icon: "rocket", color: "", sessions: [site, Staged.database], more: 0, profileId: "work")
        let home = Staged.with(spaces: spaces)
        #expect(Staged.listing(home).heads == ["realm", "site"])
        #expect(Staged.listing(home, order: .recentlyActive).heads == ["site", "realm"])
        #expect(Staged.listing(home, .all, order: .recentlyActive).heads == ["site", "realm", "thesis"])
    }

    /// Two spaces whose newest sessions moved at the same moment stay in the Mac's order.
    @Test func spacesActiveAtTheSameMomentKeepTheMacsOrder() {
        let a = Staged.row("a", space: "a", spaceName: "A", at: 50), b = Staged.row("b", space: "b", spaceName: "B", at: 50)
        let home = Staged.with(spaces: [Space(id: "a", name: "A", icon: nil, color: nil, sessions: [a], more: 0, profileId: "work"),
                                        Space(id: "b", name: "B", icon: nil, color: nil, sessions: [b], more: 0, profileId: "work")],
                               needsYou: [])
        #expect(Staged.listing(home, order: .recentlyActive).heads == ["a", "b"])
        let flipped = Staged.with(spaces: Array(home.spaces.reversed()), needsYou: [])
        #expect(Staged.listing(flipped, order: .recentlyActive).heads == ["b", "a"])
    }

    /// First, a session that waits is in Needs you and in its space; otherwise only in its space,
    /// even where it is older than the newest few the space lists.
    @Test func needsYouFirstOrInItsSpace() {
        let first = Staged.listing()
        #expect(first.needsYou.map(\.id) == ["database", "toggle"])
        #expect(first.ids == [["toggle", "relay", "mapper"], ["database"]])

        let stale = Staged.row("stale", space: "realm", spaceName: "Realm", status: .waiting, at: 10)
        let home = Staged.with(needsYou: Staged.needsYou + [stale])
        let off = Staged.listing(home, needsYouFirst: false)
        #expect(off.needsYou.isEmpty)
        #expect(off.ids == [["toggle", "relay", "mapper", "stale"], ["database"]])
        #expect(Staged.listing(home).ids.first == ["toggle", "relay", "mapper"])
    }

    @Test func aSpaceSaysWhatTheMacHoldsBeyondIt() throws {
        let realm = try #require(Staged.listing().sections.first)
        #expect(realm.more == 4)
        #expect(SpaceFooter(realm, pages: true) == .showAll(spaceId: "realm", count: 7))
        #expect(SpaceFooter(realm, pages: true)?.words == "Show all 7")
        // A Mac that does not page a space's sessions says how many more it has.
        #expect(SpaceFooter(realm, pages: false) == .more(4))
        #expect(SpaceFooter(realm, pages: false)?.words == "4 more on your Mac")
        let site = try #require(Staged.listing().sections.last)
        #expect(SpaceFooter(site, pages: true) == nil)
        // A search lists what matched, not what the Mac holds besides.
        let searched = try #require(Staged.listing(query: "relay").sections.first)
        #expect(searched.more == 0)
        #expect(SpaceFooter(searched, pages: true) == nil)
    }

    @Test func aSearchMatchesTheTitleTheSpaceTheAgentAndTheModel() {
        #expect(Staged.listing(query: "relay").ids == [["relay"]])
        #expect(Staged.listing(query: "  site ").ids == [["database"]])
        #expect(Staged.listing(query: "Codex").needsYou.map(\.id) == ["database"])
        #expect(Staged.listing(query: "DARK").needsYou.map(\.id) == ["toggle"])
        #expect(Staged.listing(query: "nothing like this").isEmpty)
        #expect(Staged.listing(query: "nothing like this").isFiltered)
        #expect(!Staged.listing(query: "   ").isFiltered)
    }

    @Test func aNeedsYouRowFindsItsSpace() {
        let listing = Staged.listing()
        #expect(listing.space(of: Staged.database)?.name == "Site")
        #expect(listing.space(of: Staged.row("x", space: "gone", spaceName: "Gone", at: 0)) == nil)
    }
}

@MainActor
@Suite("Most recent")
struct MostRecentTests {
    /// The Mac's own list, gathered for the profile shown; what waits is in Needs you, not twice.
    @Test func theMacsRecentListLessWhatNeedsYou() {
        let listing = Staged.listing(style: .mostRecent)
        #expect(listing.needsYou.map(\.id) == ["database", "toggle"])
        #expect(listing.heads == ["recent"])
        #expect(listing.ids == [["relay", "mapper", "older", "oldest"]])
    }

    @Test func withoutNeedsYouFirstWhatWaitsSitsWhereItsActivityPutsIt() {
        let stale = Staged.row("stale", space: "realm", spaceName: "Realm", status: .waiting, at: 35)
        let home = Staged.with(needsYou: Staged.needsYou + [stale])
        let listing = Staged.listing(home, style: .mostRecent, needsYouFirst: false)
        #expect(listing.needsYou.isEmpty)
        #expect(listing.ids == [["toggle", "database", "relay", "mapper", "older", "stale", "oldest"]])
    }

    /// Until the Mac answers for the profile just chosen, the list is made of what Home holds.
    @Test func aSwitchListsWhatHomeHoldsUntilTheMacAnswers() {
        #expect(HomeListing.recent(Staged.home, choice: .profile("school")).map(\.id) == ["essay", "notes", "reading"])
        #expect(Staged.listing(Staged.home, .profile("school"), style: .mostRecent).ids == [["reading"]])
        // Gathered for Work, not for every profile.
        #expect(HomeListing.recent(Staged.home, choice: .all).map(\.id)
                == ["toggle", "database", "relay", "mapper", "essay", "notes", "reading"])
        // The Mac's answer for every profile is its own list.
        let all = Staged.with(profileId: .some(nil), recent: .some([Staged.relay, Staged.reading]))
        #expect(HomeListing.recent(all, choice: .all).map(\.id) == ["relay", "reading"])
        #expect(HomeListing.recent(all, choice: .profile("work")).map(\.id) == ["toggle", "database", "relay", "mapper"])
    }

    @Test func anOlderMacsRecentListIsMadeOfItsSpaces() {
        #expect(HomeListing.recent(Staged.olderHome, choice: .all).map(\.id)
                == ["toggle", "database", "relay", "mapper", "essay", "notes", "reading"])
        #expect(Staged.listing(Staged.olderHome, .all, style: .mostRecent).ids == [["relay", "mapper", "reading"]])
    }

    /// Sessions that moved at the same moment keep the order they came in.
    @Test func aTieKeepsTheOrderItCameIn() {
        let a = Staged.row("a", space: "realm", spaceName: "Realm", at: 70), b = Staged.row("b", space: "site", spaceName: "Site", at: 70)
        #expect(Staged.listing(Staged.with(needsYou: [], recent: .some([a, b])), style: .mostRecent).ids == [["a", "b"]])
        #expect(Staged.listing(Staged.with(needsYou: [], recent: .some([b, a])), style: .mostRecent).ids == [["b", "a"]])
        #expect([b, a, Staged.toggle].merging([]).map(\.id) == ["toggle", "b", "a"])
    }

    @Test func aSearchNarrowsTheList() {
        #expect(Staged.listing(style: .mostRecent, query: "ship").ids == [["older"]])
        #expect(Staged.listing(style: .mostRecent, query: "Database").needsYou.map(\.id) == ["database"])
        #expect(Staged.listing(style: .mostRecent, query: "Database").sections.isEmpty)
    }

    @Test func nothingRecentIsNoSection() {
        let home = Staged.with(needsYou: [Staged.toggle], recent: .some([Staged.toggle]))
        let listing = Staged.listing(home, style: .mostRecent)
        #expect(listing.sections.isEmpty)
        #expect(!listing.isEmpty)
    }
}

@MainActor
@Suite("By day")
struct ByDayTests {
    static func calendar(_ zone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar
    }

    static func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0, _ second: Int = 0,
                   in zone: String = "Europe/London") -> Date {
        calendar(zone).date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second))!
    }

    static func day(_ date: Date, now: Date, in zone: String = "Europe/London") -> Day {
        Day.of(date.timeIntervalSince1970 * 1000, now: now, calendar: calendar(zone))
    }

    @Test func aDayStartsAtMidnight() {
        let now = Self.at(2026, 10, 21, 15)
        #expect(Self.day(Self.at(2026, 10, 21, 0, 0, 0), now: now) == .today)
        #expect(Self.day(Self.at(2026, 10, 20, 23, 59, 59), now: now) == .yesterday)
        #expect(Self.day(Self.at(2026, 10, 20, 0, 0, 0), now: now) == .yesterday)
        #expect(Self.day(Self.at(2026, 10, 19, 23, 59, 59), now: now) == .previousWeek)
        #expect(Self.day(Self.at(2026, 10, 14, 0, 0, 0), now: now) == .previousWeek)
        #expect(Self.day(Self.at(2026, 10, 13, 23, 59, 59), now: now) == .earlier)
        // A Mac whose clock runs a little ahead.
        #expect(Self.day(Self.at(2026, 10, 21, 15, 0, 30), now: now) == .today)
    }

    /// Just after midnight, what happened an hour ago was yesterday.
    @Test func justAfterMidnight() {
        let now = Self.at(2026, 10, 21, 0, 0, 1)
        #expect(Self.day(Self.at(2026, 10, 21, 0, 0, 0), now: now) == .today)
        #expect(Self.day(Self.at(2026, 10, 20, 23, 0), now: now) == .yesterday)
    }

    @Test func acrossAYearsEnd() {
        let now = Self.at(2027, 1, 1, 0, 30)
        #expect(Self.day(Self.at(2026, 12, 31, 23, 59), now: now) == .yesterday)
        #expect(Self.day(Self.at(2026, 12, 25, 0, 0), now: now) == .previousWeek)
        #expect(Self.day(Self.at(2026, 12, 24, 23, 59), now: now) == .earlier)
        #expect(Self.day(Self.at(2026, 1, 1, 12), now: now) == .earlier)
    }

    /// The clocks go back on 1 November 2026 in New York, so that day has 25 hours: the days are the
    /// calendar's, not lengths of 24 hours.
    @Test func daysAreTheCalendarsAcrossAChangeOfClocks() {
        let zone = "America/New_York"
        let now = Self.at(2026, 11, 2, 12, in: zone)
        #expect(Self.day(Self.at(2026, 11, 1, 0, 30, in: zone), now: now, in: zone) == .yesterday)
        #expect(Self.day(Self.at(2026, 10, 26, 0, 30, in: zone), now: now, in: zone) == .previousWeek)
        #expect(Self.day(Self.at(2026, 10, 25, 23, 30, in: zone), now: now, in: zone) == .earlier)
    }

    @Test func theDaysAreInOrderAndAnEmptyOneIsLeftOut() {
        let now = Self.at(2026, 10, 21, 15)
        let millis = { (date: Date) in date.timeIntervalSince1970 * 1000 }
        let today = Staged.row("today", space: "realm", spaceName: "Realm", at: millis(Self.at(2026, 10, 21, 9)))
        let morning = Staged.row("morning", space: "site", spaceName: "Site", at: millis(Self.at(2026, 10, 21, 1)))
        let week = Staged.row("week", space: "realm", spaceName: "Realm", at: millis(Self.at(2026, 10, 16, 9)))
        let old = Staged.row("old", space: "realm", spaceName: "Realm", at: millis(Self.at(2026, 9, 1, 9)))
        let home = Staged.with(needsYou: [], recent: .some([today, morning, week, old]))
        let listing = HomeListing(home: home, choice: .profile("work"), options: ListOptions(style: .byDay), now: now,
                                  calendar: Self.calendar("Europe/London"))
        #expect(listing.heads == ["Today", "Previous 7 days", "Earlier"])
        #expect(listing.ids == [["today", "morning"], ["week"], ["old"]])
    }

    @Test func whatNeedsYouIsNotListedTwice() {
        let listing = Staged.listing(style: .byDay)
        let listed = listing.sections.flatMap(\.rows).map(\.id)
        #expect(!listed.contains("toggle") && !listed.contains("database"))
        #expect(Set(listed) == ["relay", "mapper", "older", "oldest"])
        let off = Staged.listing(style: .byDay, needsYouFirst: false).sections.flatMap(\.rows).map(\.id)
        #expect(off.contains("toggle") && off.contains("database"))
    }
}

@MainActor
@Suite("A session's place is when its conversation last moved")
struct LastActivityTests {
    /// Set up anew after its conversation last moved: its newest change is not its activity.
    static let release = Staged.row("release", space: "realm", spaceName: "Realm", at: 300, activity: 85, title: "Plan the release")

    static func realm(_ sessions: [SessionRow]) -> Home {
        var spaces = Staged.spaces
        spaces[0] = Space(id: "realm", name: "Realm", icon: "emoji:🌊", color: "", sessions: sessions, more: 0, profileId: "work")
        return Staged.with(spaces: spaces, needsYou: [], profileId: .some("school"))
    }

    @Test func aListMadeOfHomesRowsIsInOrderOfActivity() {
        let home = Self.realm([Staged.toggle, Staged.relay, Self.release])
        #expect(HomeListing.recent(home, choice: .profile("work")).map(\.id) == ["toggle", "database", "relay", "release"])
        #expect([Self.release, Staged.toggle].merging([]).map(\.id) == ["toggle", "release"])
        #expect(Staged.listing(home, style: .mostRecent, needsYouFirst: false).ids == [["toggle", "database", "relay", "release"]])
    }

    @Test func spacesAreOrderedByTheirNewestActivity() {
        // Site's one session was only set up anew since Realm's last moved.
        let configured = Staged.row("configured", space: "site", spaceName: "Site", at: 500, activity: 20)
        var spaces = Staged.spaces
        spaces[1] = Space(id: "site", name: "Site", icon: "rocket", color: "", sessions: [configured], more: 0, profileId: "work")
        let home = Staged.with(spaces: spaces, needsYou: [])
        #expect(Staged.listing(home, order: .recentlyActive).heads == ["realm", "site"])
    }

    @Test func aSessionIsOnTheDayItsConversationMoved() {
        let now = ByDayTests.at(2026, 10, 21, 15)
        let millis = { (date: Date) in date.timeIntervalSince1970 * 1000 }
        let row = Staged.row("release", space: "realm", spaceName: "Realm", at: millis(now), activity: millis(ByDayTests.at(2026, 10, 18, 9)))
        let home = Staged.with(needsYou: [], recent: .some([row]))
        let listing = HomeListing(home: home, choice: .profile("work"), options: ListOptions(style: .byDay), now: now,
                                  calendar: ByDayTests.calendar("Europe/London"))
        #expect(listing.heads == ["Previous 7 days"])
    }

    @Test func aRowsAgeIsItsActivitys() {
        let now = Date(timeIntervalSince1970: 1_790_007_200)
        let row = Staged.row("release", space: "realm", spaceName: "Realm", at: 1_790_007_100_000, activity: 1_790_000_000_000,
                             title: "Plan the release")
        #expect(SessionRowView.spoken(row, now: now) == "Plan the release, Realm, Claude, 2h ago")
    }

    @Test func aSpacesPageKeepsAReadSessionWhereItWas() {
        var pages = SpacePages()
        pages.start(SpaceSessions(sessions: [Staged.toggle, Staged.relay, Staged.mapper], more: true))
        // Read since: a newer word of it, at the same activity.
        let read = Staged.row("relay", space: "realm", spaceName: "Realm", at: 400, activity: 90, title: "Explain the relay")
        // Set up anew long after it last moved, and older than everything here: its page brings it.
        let configured = Staged.row("configured", space: "realm", spaceName: "Realm", at: 999, activity: 10)
        pages.refresh(with: [read, configured])
        #expect(pages.rows.map(\.id) == ["toggle", "relay", "mapper"])
        #expect(pages.rows[1].updatedAt == 400)
    }
}

@MainActor
@Suite("A space's page")
struct SpacePagesTests {
    static func page(_ rows: [SessionRow], more: Bool) -> SpaceSessions { SpaceSessions(sessions: rows, more: more) }

    @Test func pagesFollowOneAnotherWithNoSessionTwice() {
        var pages = SpacePages()
        #expect(!pages.loaded && pages.offset == 0)
        pages.start(Self.page([Staged.toggle, Staged.relay], more: true))
        #expect(pages.loaded && pages.more && pages.offset == 2)
        // A session moved up since: the next page repeats one already here.
        pages.append(Self.page([Staged.relay, Staged.mapper], more: false))
        #expect(pages.rows.map(\.id) == ["toggle", "relay", "mapper"])
        #expect(!pages.more)
        // Pulled to refresh: the first page again, alone.
        pages.start(Self.page([Staged.relay], more: true))
        #expect(pages.rows.map(\.id) == ["relay"] && pages.more)
    }

    @Test func homesNewerWordTakesEachRowsPlace() {
        var pages = SpacePages()
        pages.start(Self.page([Staged.toggle, Staged.relay, Staged.mapper], more: true))
        let finished = Staged.row("toggle", space: "realm", spaceName: "Realm", at: 100, title: "Add the dark-mode toggle")
        let moved = Staged.row("mapper", space: "realm", spaceName: "Realm", status: .running, at: 130)
        let started = Staged.row("new", space: "realm", spaceName: "Realm", at: 120)
        let unseen = Staged.row("deep", space: "realm", spaceName: "Realm", at: 5)
        let stale = Staged.row("relay", space: "realm", spaceName: "Realm", status: .error, at: 1)
        pages.refresh(with: [finished, moved, started, unseen, stale])
        #expect(pages.rows.map(\.id) == ["mapper", "new", "toggle", "relay"])
        #expect(pages.rows[0].status == .running)
        #expect(pages.rows[2].status == .idle, "the toggle finished")
        #expect(pages.rows[3].status == .idle, "an older word does not replace a newer one")
        #expect(pages.offset == 4)
    }

    @Test func onceEveryPageIsHereANewSessionJoinsWhereverItFalls() {
        var pages = SpacePages()
        pages.start(Self.page([Staged.relay], more: false))
        pages.refresh(with: [Staged.row("deep", space: "realm", spaceName: "Realm", at: 5)])
        #expect(pages.rows.map(\.id) == ["relay", "deep"])
    }

    @Test func beforeTheFirstPageHomesWordWaits() {
        var pages = SpacePages()
        pages.refresh(with: [Staged.relay])
        #expect(pages.rows.isEmpty && !pages.loaded)
    }

    @Test func whileTheMacIsAwayThePageSaysWhatItHoldsBesides() {
        let realm = Staged.spaces[0]
        #expect(SpacePages().rest(beyond: realm) == "4 more on your Mac")
        #expect(SpacePages().rest(beyond: Staged.spaces[1]) == nil)
        var pages = SpacePages()
        pages.start(Self.page([Staged.relay], more: true))
        #expect(pages.rest(beyond: realm) == "The rest are on your Mac.")
        pages.start(Self.page([Staged.relay], more: false))
        #expect(pages.rest(beyond: realm) == nil)
    }

    @Test func homeHoldsASpacesRowsInThreePlacesAndEachIsTakenOnce() {
        #expect(Staged.home.rows(of: "realm").map(\.id) == ["toggle", "relay", "mapper", "older", "oldest"])
        #expect(Staged.home.rows(of: "thesis").map(\.id) == ["essay", "notes", "reading"])
        #expect(Staged.home.rows(of: "nowhere").isEmpty)
    }
}

@MainActor
@Suite("Words for the session list")
struct SessionListWordsTests {
    @Test func aSearchThatFoundNothingSaysWhatItSearched() {
        #expect(NoResults.words(style: .bySpace, pages: true)
                == "This searches the sessions listed here: each space's latest. Each space's page lists all of its own.")
        #expect(NoResults.words(style: .byDay, pages: false)
                == "This searches the sessions listed here: the most recent. The rest are on your Mac.")
    }

    @Test func everyStyleSaysWhatItLists() {
        #expect(ListStyle.allCases.map(\.title) == ["By space", "Most recent", "By day"])
        #expect(SpaceOrder.allCases.map(\.title) == ["As on your Mac", "Recently active first"])
        #expect(Day.allCases.map(\.title) == ["Today", "Yesterday", "Previous 7 days", "Earlier"])
        for style in ListStyle.allCases { #expect(style.explanation.hasSuffix(".")) }
    }

    /// What has not gone keeps its session's title when only the recent list names it.
    @Test func anUnsentSessionTakesItsTitleFromTheRecentList() {
        var outbox = Outbox()
        outbox.add(OutgoingItem(sessionId: "older", payload: .message(text: "Go"), afterSeq: 0))
        #expect(UnsentSession.list(outbox: outbox, home: Staged.home, connected: false).first?.title == "Ship 2.0.3")
    }
}

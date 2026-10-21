import Foundation
import RealmKit

/// How Home lists sessions. It is the person's to choose, in Home's View options menu and in Settings ▸
/// Session list, both kept under the same keys.
enum ListStyle: String, CaseIterable, Identifiable {
    /// Each space's newest sessions under its name, as the Mac's sidebar has them.
    case bySpace
    /// One list, the newest activity first.
    case mostRecent
    /// The same list under the day each session last moved.
    case byDay

    var id: Self { self }

    var title: String {
        switch self {
        case .bySpace: "By space"
        case .mostRecent: "Most recent"
        case .byDay: "By day"
        }
    }

    var symbol: String {
        switch self {
        case .bySpace: "folder"
        case .mostRecent: "clock"
        case .byDay: "calendar"
        }
    }

    /// What the style lists, for the foot of Settings ▸ Session list.
    var explanation: String {
        switch self {
        case .bySpace: "Each space's newest sessions, under its name. A space's name opens all of its sessions."
        case .mostRecent: "One list, the newest activity first, each session with its space."
        case .byDay: "One list under Today, Yesterday, Previous 7 days and Earlier, each session with its space."
        }
    }
}

/// The order By space puts the spaces in.
enum SpaceOrder: String, CaseIterable, Identifiable {
    case asOnMac
    /// By each space's newest session.
    case recentlyActive

    var id: Self { self }

    var title: String {
        switch self {
        case .asOnMac: "As on your Mac"
        case .recentlyActive: "Recently active first"
        }
    }
}

/// How the person asked for the list, as kept on the phone.
struct ListOptions: Equatable {
    var style = ListStyle.bySpace
    var spaceOrder = SpaceOrder.asOnMac
    /// Needs you heads the list. Off, those sessions sit where their activity puts them.
    var needsYouFirst = true

    /// The keys the options are kept under, which Home's menu and Settings both bind to.
    enum Key {
        static let style = "sessionList.style"
        static let spaceOrder = "sessionList.spaceOrder"
        static let needsYouFirst = "sessionList.needsYouFirst"
    }
}

/// Which of the Mac's profiles Home shows: one of them, or all at once.
enum ProfileChoice: Hashable {
    case profile(String)
    case all

    /// What `home.get` is asked to gather `recent` for: the profile, or nil for every profile.
    var profileId: String? {
        if case .profile(let id) = self { return id }
        return nil
    }

    /// As it is kept on the phone, one key per Mac.
    var stored: String {
        switch self {
        case .profile(let id): "profile:\(id)"
        case .all: "all"
        }
    }

    init?(stored: String) {
        if stored == "all" {
            self = .all
        } else if stored.hasPrefix("profile:"), stored.count > "profile:".count {
            self = .profile(String(stored.dropFirst("profile:".count)))
        } else {
            return nil
        }
    }

    /// The choice Home shows. The one kept, while the Mac still has that profile and it has a space;
    /// else the first profile with a space, as the Mac's sidebar offers only those. A Mac with one
    /// profile, or too old to say, shows everything, as Home did before profiles.
    static func resolve(_ kept: ProfileChoice?, in home: Home) -> ProfileChoice {
        guard let profiles = home.profiles, profiles.count > 1 else { return .all }
        if kept == .all { return .all }
        let withSpaces = Set(home.spaces.compactMap(\.profileId))
        if case .profile(let id)? = kept, withSpaces.contains(id), profiles.contains(where: { $0.id == id }) {
            return .profile(id)
        }
        return .profile((profiles.first { withSpaces.contains($0.id) } ?? profiles[0]).id)
    }

    /// Home's title: the profile's name, "All profiles", or "Sessions" where there is nothing to switch.
    func title(in home: Home?) -> String {
        guard let profiles = home?.profiles, profiles.count > 1 else { return "Sessions" }
        switch self {
        case .all: return "All profiles"
        case .profile(let id): return profiles.first { $0.id == id }?.name ?? "Sessions"
        }
    }

    /// What Home says when it lists nothing, naming the profile it looked in.
    func emptyWords(in home: Home?) -> String {
        guard case .profile(let id) = self, let profiles = home?.profiles, profiles.count > 1,
              let profile = profiles.first(where: { $0.id == id }) else { return "No sessions yet" }
        return "No sessions in \(profile.name) yet"
    }
}

/// A day a session last moved on, as By day heads its sessions. Calendar days in the phone's own
/// calendar and time zone: a session from 11 pm is Yesterday at 1 am.
enum Day: String, CaseIterable {
    case today, yesterday, previousWeek, earlier

    var title: String {
        switch self {
        case .today: "Today"
        case .yesterday: "Yesterday"
        case .previousWeek: "Previous 7 days"
        case .earlier: "Earlier"
        }
    }

    /// The day `millis` falls on, seen from `now`. A moment ahead of the phone's clock — the Mac's
    /// may run a little fast — is today.
    static func of(_ millis: Millis, now: Date, calendar: Calendar) -> Day {
        let date = Date(timeIntervalSince1970: millis / 1000)
        let today = calendar.startOfDay(for: now)
        if date >= today { return .today }
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: today),
              let weekBefore = calendar.date(byAdding: .day, value: -7, to: today) else { return .earlier }
        if date >= yesterday { return .yesterday }
        if date >= weekBefore { return .previousWeek }
        return .earlier
    }
}

/// A section of Home after Needs you: a space, a day, or the one list of Most recent.
struct ListSection: Identifiable {
    enum Head {
        case space(Space)
        case day(Day)
        case recent
    }

    let head: Head
    let rows: [SessionRow]
    /// How many of a space's sessions the Mac holds beyond its rows here: 0 for a day, for Most
    /// recent, and in a search, which lists only what matched.
    let more: Int

    var id: String {
        switch head {
        case .space(let space): "space/\(space.id)"
        case .day(let day): "day/\(day.rawValue)"
        case .recent: "recent"
        }
    }
}

/// Sessions that need the person in a profile Home is not showing, so nothing waits unseen.
struct ProfileWaiting: Identifiable, Equatable {
    let profile: Profile
    let count: Int

    var id: String { profile.id }

    /// "2 need you in School"
    var words: String { "\(Self.count(count)) in \(profile.name)" }

    /// "1 needs you", "2 need you": Needs you lists failures beside requests, so not "waiting".
    static func count(_ count: Int) -> String {
        count == 1 ? "1 needs you" : "\(count) need you"
    }
}

/// What Home lists, from what the Mac sent and how the person asked for it: what needs them in the
/// other profiles, Needs you, then the sessions in the chosen style. Everything is the chosen
/// profile's, and narrowed by a search over the title, the space, the agent and the model.
struct HomeListing {
    let needsYou: [SessionRow]
    let sections: [ListSection]
    /// Other profiles with something that needs the person, in the Mac's order; none in a search.
    let elsewhere: [ProfileWaiting]
    let isFiltered: Bool
    private let spacesById: [String: Space]

    init(home: Home, choice: ProfileChoice, options: ListOptions = ListOptions(), query: String = "",
         now: Date = Date(), calendar: Calendar = .current) {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        isFiltered = !words.isEmpty
        let spacesById = Dictionary(home.spaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        self.spacesById = spacesById
        let inScope = { (row: SessionRow) in
            choice == .all || spacesById[row.spaceId]?.profileId == choice.profileId
        }
        let matches = { (row: SessionRow) in row.matches(words) }
        let waiting = home.needsYou.filter(inScope)
        needsYou = options.needsYouFirst ? waiting.filter(matches) : []
        elsewhere = isFiltered ? [] : Self.elsewhere(home, choice: choice)

        switch options.style {
        case .bySpace:
            let bySpace = Dictionary(grouping: waiting, by: \.spaceId)
            var spaces = home.spaces.filter { choice == .all || $0.profileId == choice.profileId }.map { space in
                // Off, Needs you is no section of its own: a space holds what waits in it, even a
                // session older than the newest few it lists.
                (space, options.needsYouFirst ? space.sessions : space.sessions.merging(bySpace[space.id] ?? []))
            }
            if options.spaceOrder == .recentlyActive {
                spaces = spaces.stablySorted { ($0.1.map(\.updatedAt).max() ?? 0) > ($1.1.map(\.updatedAt).max() ?? 0) }
            }
            sections = spaces.compactMap { space, rows in
                let shown = rows.filter(matches)
                return shown.isEmpty ? nil : ListSection(head: .space(space), rows: shown, more: words.isEmpty ? space.more : 0)
            }
        case .mostRecent, .byDay:
            let listed = Self.recent(home, choice: choice)
            let ids = Set(waiting.map(\.id))
            // First, Needs you holds what waits, and the list does not say it twice.
            let rows = (options.needsYouFirst ? listed.filter { !ids.contains($0.id) } : listed.merging(waiting)).filter(matches)
            if options.style == .mostRecent {
                sections = rows.isEmpty ? [] : [ListSection(head: .recent, rows: rows, more: 0)]
            } else {
                let byDay = Dictionary(grouping: rows) { Day.of($0.updatedAt, now: now, calendar: calendar) }
                sections = Day.allCases.compactMap { day in
                    byDay[day].map { ListSection(head: .day(day), rows: $0, more: 0) }
                }
            }
        }
    }

    /// The sessions active most recently in the chosen profile, newest first: the Mac's own list
    /// where it was gathered for this choice, else one made of what Home already holds — each
    /// space's newest and Needs you — so a switch lists something at once, until the Mac answers.
    static func recent(_ home: Home, choice: ProfileChoice) -> [SessionRow] {
        if let recent = home.recent, home.profileId == choice.profileId { return recent }
        let spaces = home.spaces.filter { choice == .all || $0.profileId == choice.profileId }
        let ids = Set(spaces.map(\.id))
        let waiting = home.needsYou.filter { choice == .all || ids.contains($0.spaceId) }
        return spaces.flatMap(\.sessions).merging(waiting)
    }

    /// How many sessions need the person in each profile, by its id: Needs you's rows, by the
    /// profile of each one's space.
    static func needing(_ home: Home) -> [String: Int] {
        let profileOfSpace = Dictionary(home.spaces.compactMap { space in space.profileId.map { (space.id, $0) } },
                                        uniquingKeysWith: { first, _ in first })
        var counts: [String: Int] = [:]
        for row in home.needsYou {
            if let profile = profileOfSpace[row.spaceId] { counts[profile, default: 0] += 1 }
        }
        return counts
    }

    private static func elsewhere(_ home: Home, choice: ProfileChoice) -> [ProfileWaiting] {
        guard case .profile(let shown) = choice, let profiles = home.profiles else { return [] }
        let counts = needing(home)
        return profiles.compactMap { profile in
            guard profile.id != shown, let count = counts[profile.id], count > 0 else { return nil }
            return ProfileWaiting(profile: profile, count: count)
        }
    }

    /// The space a row belongs to, for the glyph and name a row shows where no section names it.
    func space(of row: SessionRow) -> Space? {
        spacesById[row.spaceId]
    }

    var isEmpty: Bool {
        needsYou.isEmpty && sections.isEmpty
    }
}

extension SessionRow {
    /// A search's words, trimmed, are in the session's title, its space, its agent or its model.
    /// No words match everything.
    func matches(_ words: String) -> Bool {
        words.isEmpty || [title, spaceName, agentDisplayName, modelDisplayName ?? ""].contains { $0.localizedStandardContains(words) }
    }
}

extension Array where Element == SessionRow {
    /// These rows and those of `other` not already among them, the newest activity first.
    func merging(_ other: [SessionRow]) -> [SessionRow] {
        let ids = Set(map(\.id))
        return (self + other.filter { !ids.contains($0.id) }).stablySorted { $0.updatedAt > $1.updatedAt }
    }
}

extension Array {
    /// Sorted, with elements the order does not tell apart kept in the order they came in: two
    /// sessions that moved at the same moment stay as the Mac listed them.
    func stablySorted(by isBefore: (Element, Element) -> Bool) -> [Element] {
        enumerated().sorted { a, b in
            if isBefore(a.element, b.element) { return true }
            if isBefore(b.element, a.element) { return false }
            return a.offset < b.offset
        }.map(\.element)
    }
}

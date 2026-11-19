import RealmKit
import SwiftUI

/// The sidebar's answer to "what should I look at", as an inbox: what needs you, what has not gone
/// yet, then the sessions in the list style the person chose. One profile at a time, named in the
/// title, which switches it; under the title, the Mac and its state.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(ListOptions.Key.style) private var style = ListOptions().style
    @AppStorage(ListOptions.Key.spaceOrder) private var spaceOrder = ListOptions().spaceOrder
    @AppStorage(ListOptions.Key.needsYouFirst) private var needsYouFirst = ListOptions().needsYouFirst
    @State private var query = ""
    @State private var searching = false
    /// What the Mac's search last found, while the words in the field are enough to send.
    @State private var found: FoundSessions?
    @State private var filter = HomeFilter.all
    @State private var reconnecting = false
    @State private var newSessionShown = false
    /// How far a short list of search results is pushed down to sit on the field.
    @State private var resultsLift: CGFloat = 0
    /// The moment By day reckons its days from, moved on at midnight and on coming back to the app.
    @State private var now = Date()
    @Namespace private var settingsZoom

    /// Between a section's last row and the next head: a little more than between its own rows.
    static let sectionSpacing: CGFloat = 12

    var body: some View {
        @Bindable var model = model
        let home = model.store.home.map { model.rowEdits.applied(to: $0) }
        let choice = model.profileChoice
        let options = ListOptions(style: style, spaceOrder: spaceOrder, needsYouFirst: needsYouFirst)
        let team = home.map { TeamListing.teammates(model.work.teammates ?? [], in: $0, choice: choice) } ?? []
        let listing = home.map { HomeListing(home: $0, choice: choice, options: options, query: query, now: now,
                                             teamChats: Set(team.compactMap(\.chatId))) }
        let unsent = UnsentSession.list(outbox: model.store.outbox, home: home, connected: model.isConnected)
        let shown = model.shownLinkStatus
        // A Mac that names its profiles pages a space's sessions too; an older one has only Home's few.
        let pages = home?.profiles != nil
        let matches = SearchQuery.sent(query) == nil ? nil : found
        List {
            if let matches, let home {
                SearchHitsSection(found: matches, home: home)
            } else if let listing {
                if !listing.isFiltered, let home {
                    TeamRow(teammates: TeamListing.row(team, in: home, choice: choice))
                }
                ForEach(listing.elsewhere) { waiting in
                    ElsewhereRow(waiting: waiting)
                }
                if filter == .all {
                    WorkHeadLines(searching: listing.isFiltered)
                    if !listing.isFiltered, !model.work.unsupported {
                        HomePlaces()
                    }
                }
                if !listing.needsYou.isEmpty, filter != .pinned {
                    Section {
                        // A session that needs you is listed in its space too: each row has its
                        // section's identity, or the list draws one of the two as a hole.
                        ForEach(listing.needsYou, id: \.needsYouKey) { row in
                            SessionLink(row: row, space: listing.space(of: row))
                        }
                    } header: {
                        SectionHead(title: "Needs you") { EmptyView() }
                    }
                }
                if !listing.pinned.isEmpty, filter != .needsYou {
                    Section {
                        ForEach(listing.pinned, id: \.pinnedKey) { row in
                            SessionLink(row: row, space: listing.space(of: row))
                        }
                    } header: {
                        SectionHead(title: "Pinned") {
                            Image(systemName: "pin.fill").foregroundStyle(Palette.ink2)
                        }
                    }
                }
                if !unsent.isEmpty, !listing.isFiltered, filter == .all {
                    Section {
                        ForEach(unsent) { session in
                            UnsentRow(session: session)
                        }
                    } header: {
                        SectionHead(title: "Unsent") {
                            Image(systemName: "arrow.up.circle.fill").foregroundStyle(Palette.ink2)
                        }
                    }
                }
                if filter == .all, !listing.isFiltered, let home {
                    let archived = TeamListing.teammates(model.work.archivedTeammates, in: home, choice: choice)
                    if !team.isEmpty || !archived.isEmpty {
                        TeamSection(count: team.count, spaceId: (team.first ?? archived.first)?.spaceId, archived: archived)
                    }
                }
                ForEach(filter == .all ? listing.sections : []) { section in
                    Section {
                        ForEach(section.rows) { row in
                            SessionLink(row: row, space: section.namesSpace ? nil : listing.space(of: row))
                        }
                        if case .space(let space) = section.head, let footer = SpaceFooter(section, pages: pages) {
                            SpaceFooterRow(footer: footer, spaceName: space.name)
                        }
                    } header: {
                        ListSectionHead(section: section, opensSpace: pages)
                    }
                }
            } else if shown.kind == .connecting || shown.kind == .connected {
                LoadingSections()
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(Self.sectionSpacing)
        .scrollContentBackground(.hidden)
        // The last row scrolls clear of the New session button floating over the list's foot; while
        // searching the button is gone, and the results sit down on the field.
        .contentMargins(.bottom, searching ? 0 : 72, for: .scrollContent)
        // Results grow up from the search field at the foot, the best nearest it. A List takes no
        // alignment anchor, so a few results are pushed down by the room left over them.
        .contentMargins(.top, matches == nil ? 0 : resultsLift, for: .scrollContent)
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.containerSize.height - geometry.contentInsets.top - geometry.contentInsets.bottom - geometry.contentSize.height
        } action: { _, room in
            resultsLift = matches == nil ? 0 : max(0, resultsLift + room)
        }
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .modifier(BestResultInView(best: matches?.hits.first?.id))
        .id(ListIdentity(choice: choice, style: style))
        // Manus's chips under the bar: what the list holds, by what it asks of the person. The list
        // blurs and fades under them as it does under the bar.
        .safeAreaBar(edge: .top, spacing: 0) {
            if let listing, matches == nil {
                HomeChips(filter: $filter, needsYou: listing.needsYou.count, pinned: listing.pinned.count)
            }
        }
        // Manus's one button for a new task, floating at the foot's trailing corner.
        .overlay(alignment: .bottomTrailing) {
            if model.agentList != nil, !searching {
                NewSessionButton { newSessionShown = true }
                    .padding(.trailing, 20)
                    .padding(.bottom, 12)
                    .matchedTransitionSource(id: "new-session", in: settingsZoom)
            }
        }
        .overlay {
            if home == nil, shown.kind != .connecting, shown.kind != .connected {
                FirstLoad()
            } else if let matches, matches.hits.isEmpty {
                NoResults(query: matches.query, why: NoResults.macWords)
            } else if matches == nil, let listing, listing.isEmpty, unsent.isEmpty {
                if listing.isFiltered {
                    NoResults(query: query, why: NoResults.words(style: style, pages: pages))
                } else {
                    EmptyState(choice.emptyWords(in: home), systemImage: "text.bubble",
                               description: model.agentList == nil ? "Start one in Realm on your Mac, and it shows here." : "Tap New session at the bottom to start one.")
                }
            }
        }
        .navigationTitle(choice.title(in: home))
        .navigationBarTitleDisplayMode(.inline)
        .modifier(ProfileSwitcher(home: home, choice: choice,
                                  subtitle: MacLine.text(model: model, compact: dynamicTypeSize.isAccessibilitySize)))
        .sensoryFeedback(.selection, trigger: model.keptProfile)
        .sensoryFeedback(.selection, trigger: style)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.significantTimeChangeNotification)) { _ in now = Date() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { now = Date() } }
        .toolbar {
            // While the Mac is away, a way to try now rather than at the end of the wait between
            // tries — in the bar, so the list under it never moves for the link's sake.
            // On the leading side, opposite More, so the title stays centred while it is there.
            if home != nil, !shown.isConnected, shown.kind != .connecting {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task {
                            reconnecting = true
                            await model.refresh()
                            reconnecting = false
                        }
                    } label: {
                        if reconnecting {
                            ProgressView()
                        } else {
                            Label("Reconnect", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(reconnecting)
                }
                .sharedBackgroundVisibility(.hidden)
            }
            // The Mac and everything about it, at the leading corner as Manus keeps its profile.
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    model.settingsShown = true
                } label: {
                    Label("Your Mac", systemImage: "laptopcomputer")
                }
                .accessibilityIdentifier("home-menu")
            }
            .sharedBackgroundVisibility(.hidden)
            .matchedTransitionSource(id: "settings", in: settingsZoom)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    searching = true
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .accessibilityIdentifier("search")
            }
            .sharedBackgroundVisibility(.hidden)
        }
        .modifier(SearchWhenAsked(query: $query, searching: $searching))
        // Asked of the Mac once the typing rests, as the desktop's palette asks; a newer word cancels
        // the older ask, so an answer never lands under words it was not for.
        .task(id: SearchAsk(query: SearchQuery.sent(query), choice: choice)) {
            guard let words = SearchQuery.sent(query) else {
                found = nil
                return
            }
            try? await Task.sleep(for: FoundSessions.restsFor)
            guard !Task.isCancelled else { return }
            let hits = await model.search(words)
            guard !Task.isCancelled else { return }
            found = hits.map { FoundSessions(query: words, hits: $0) }
        }
        .refreshable { await model.refresh() }
        .sheet(isPresented: $model.settingsShown) {
            SettingsSheet()
                .navigationTransition(.zoom(sourceID: "settings", in: settingsZoom))
        }
        .sheet(isPresented: $newSessionShown) {
            NewSessionSheet()
                .navigationTransition(.zoom(sourceID: "new-session", in: settingsZoom))
        }
        .onChange(of: model.sharedNewSession, initial: true) { _, shared in
            if shared != nil { newSessionShown = true }
        }
    }
}

/// The line under Home's title: the link's glyph in its tone, then the Mac and its state in words —
/// "MacBook Pro · Asleep since 10:42", and when what is listed is this iPhone's copy, how old it is.
/// At the accessibility sizes it is the state alone, the part that changes what the list means.
enum MacLine {
    @MainActor
    static func text(model: AppModel, compact: Bool) -> Text {
        let status = model.shownLinkStatus
        var words = compact ? status.words : model.macLine
        if !status.isConnected, let savedAt = model.store.homeSavedAt {
            let updated = "Updated \(LinkStatus.moment(savedAt, now: Date(), calendar: .current, locale: .current))"
            words = compact ? updated : "\(status.words) · \(updated)"
        }
        return Text("\(Text(Image(systemName: status.kind.glyph)).foregroundStyle(status.kind.tone.agentColor)) \(words)")
    }
}

/// More results than fit open at the best, nearest the field at the foot, each time the Mac sends new ones.
private struct BestResultInView: ViewModifier {
    let best: SearchHit.ID?

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: best, initial: true) {
                if let best { proxy.scrollTo(best, anchor: .bottom) }
            }
        }
    }
}

/// What makes one list another: a switch of profile or of style starts the new one at its top.
private struct ListIdentity: Hashable {
    let choice: ProfileChoice
    let style: ListStyle
}

extension SessionRow {
    /// A Needs-you row's identity, apart from the same session's row in its space.
    var needsYouKey: String { "needs-you/\(id)" }

    var displayTitle: String { title.isEmpty ? "Untitled session" : title }

    /// A turn is under way, or waits on the person: Stop has something to stop.
    var isWorking: Bool { status.isWorking }
}

extension SessionStatus {
    var isWorking: Bool { self == .running || self == .waiting }
}

/// What a row says about its session, at the end of its first line: the state a person would act on
/// or want to know, as a glyph and a word in its tone. A session at rest says nothing, and its row
/// shows how long ago it moved instead. A lead whose sub-agent waits on a request says so, as the
/// desktop's sidebar does, ahead of its own turn working.
enum RowState: Equatable {
    case waiting, working, failed, done
    /// Its sub-agents' requests, said in words: "1 sub-agent needs you".
    case subagentsWaiting(String)

    init?(_ row: SessionRow) {
        if row.status != .waiting, let subagents = RowSubagents(row), subagents.waiting > 0 {
            self = .subagentsWaiting(subagents.words)
            return
        }
        switch row.status {
        case .waiting: self = .waiting
        case .running, .moving: self = .working
        case .error: self = .failed
        // A turn that finished while the person was away, and has not been read.
        case .idle where row.unread: self = .done
        case .idle, .ended, .other: return nil
        }
    }

    var word: String {
        switch self {
        case .waiting: "Waiting on you"
        case .working: "Working"
        case .failed: "Failed"
        case .done: "Done"
        case .subagentsWaiting(let words): words
        }
    }

    var symbol: String {
        switch self {
        case .waiting, .subagentsWaiting: "hand.raised.fill"
        case .working: "progress.indicator"
        case .failed: "exclamationmark.circle.fill"
        case .done: "checkmark.circle.fill"
        }
    }

    var tone: Tone {
        switch self {
        case .waiting, .subagentsWaiting: .waiting
        case .working: .working
        case .failed: .failed
        case .done: .done
        }
    }
}

/// A section's name in sentence case beside its glyph, at the list's head rung. A plain list pins its
/// heads, so a head stands on the list's own ground from edge to edge: the rows scrolling under it
/// go out of sight rather than showing through its words.
struct SectionHead<Glyph: View>: View {
    let title: String
    /// The head opens what it names, and a chevron after the name says so.
    var opens = false
    @ViewBuilder let glyph: Glyph

    var body: some View {
        HStack(spacing: 7) {
            glyph
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(2)
                .accessibilityAddTraits(.isHeader)
            if opens {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
                    .accessibilityHidden(true)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Palette.ink)
        .textCase(nil)
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .pinnedOnGround()
        .listRowInsets(EdgeInsets())
    }
}

/// The head of a section after Needs you. A space's opens its page where the Mac pages a space's
/// sessions, with the chevron that says so; a day's and Most recent's only name what is under them.
struct ListSectionHead: View {
    let section: ListSection
    let opensSpace: Bool

    var body: some View {
        switch section.head {
        case .space(let space):
            if opensSpace {
                NavigationLink(value: Route.space(space.id)) {
                    // The whole head is pressed, not only its words: it is a row's width to a finger,
                    // as it is to VoiceOver.
                    SectionHead(title: space.name, opens: true) { SpaceGlyph(space: space) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
                .accessibilityAddTraits(.isHeader)
                .accessibilityHint("Shows all of its sessions")
            } else {
                SectionHead(title: space.name) { SpaceGlyph(space: space) }
            }
        case .day(let day):
            // A glyph like every other head's, so the heads' words start together.
            SectionHead(title: day.title) {
                Image(systemName: "calendar").foregroundStyle(Palette.ink2)
            }
        case .recent:
            SectionHead(title: "Recent") {
                Image(systemName: "clock").foregroundStyle(Palette.ink2)
            }
        }
    }
}

extension ListSection {
    /// The section's head names the space of every row under it.
    var namesSpace: Bool {
        if case .space = head { return true }
        return false
    }
}

/// Under a space's rows, when the Mac holds more of its sessions: the way to all of them where the
/// Mac pages them, else how many more it has. Nothing in a search, which lists only what matched.
enum SpaceFooter: Equatable {
    case showAll(spaceId: String, count: Int)
    case more(Int)

    init?(_ section: ListSection, pages: Bool) {
        guard case .space(let space) = section.head, section.more > 0 else { return nil }
        self = pages ? .showAll(spaceId: space.id, count: section.rows.count + section.more) : .more(section.more)
    }

    var words: String {
        switch self {
        case .showAll(_, let count): "Show all \(count)"
        case .more(let count): "\(count) more on your Mac"
        }
    }
}

/// A line of the list rather than its footer, which a plain list paints in the system's own ground
/// instead of Realm's.
private struct SpaceFooterRow: View {
    let footer: SpaceFooter
    let spaceName: String

    var body: some View {
        Group {
            switch footer {
            case .showAll(let spaceId, let count):
                NavigationLink(value: Route.space(spaceId)) {
                    Text(footer.words)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                }
                .accessibilityLabel("Show all \(count) sessions in \(spaceName)")
            case .more:
                Text(footer.words)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden, edges: .bottom)
    }
}

/// At the head of the list, what needs the person in a profile Home is not showing, a press from
/// being shown: one line for each such profile.
struct ElsewhereRow: View {
    let waiting: ProfileWaiting
    @Environment(AppModel.self) private var model

    var body: some View {
        HeadLine(symbol: "hand.raised.fill", tone: Tone.waiting.agentColor, words: waiting.words) {
            model.choose(.profile(waiting.profile.id))
        }
        .accessibilityHint("Shows \(waiting.profile.name)")
        .accessibilityIdentifier("elsewhere-\(waiting.profile.id)")
    }
}

/// The title opens the menu of profiles while the Mac has more than one; with one, or none it says,
/// there is nothing to switch, and no chevron says otherwise. The whole title, its name and the line
/// under it, is the control, at least 44 points tall: the name alone was 63 by 18 (the audit's HOME-08).
/// The bar's own subtitle is only set without it, or the bar draws the line a second time under it.
private struct ProfileSwitcher: ViewModifier {
    let home: Home?
    let choice: ProfileChoice
    let subtitle: Text

    func body(content: Content) -> some View {
        if let home, let profiles = home.profilesToSwitch {
            content.toolbar {
                ToolbarItem(placement: .principal) {
                    RealmMenu("Profiles", hint: "Shows another profile's sessions") {
                        ProfileMenu(home: home, profiles: profiles, choice: choice)
                    } label: {
                        ProfileTitle(name: choice.title(in: home), subtitle: subtitle)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("profile-switcher")
                }
            }
        } else {
            content.navigationSubtitle(subtitle)
        }
    }
}

/// The bar's title as the switcher draws it: the profile's name with a chevron, the Mac's line under it,
/// at the bar's own sizes. Like the bar's own title it keeps its size past the largest text size, and a
/// long press shows it large.
struct ProfileTitle: View {
    let name: String
    let subtitle: Text

    var body: some View {
        VStack(spacing: 1) {
            HStack(spacing: 4) {
                Text(name)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Palette.ink3)
            }
            subtitle
                .font(.caption)
                .foregroundStyle(Palette.ink2)
        }
        .lineLimit(1)
        .padding(.horizontal, 12)
        .frame(minWidth: 120, minHeight: 44)
        .contentShape(Rectangle())
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityShowsLargeContentViewer {
            Text(name)
        }
    }
}

/// The title's menu: the Mac's profiles in its order, each with its mark and what needs the person
/// in it, then all of them at once. A profile with no spaces is listed and not offered, as on the Mac.
private struct ProfileMenu: View {
    let home: Home
    let profiles: [Profile]
    let choice: ProfileChoice
    @Environment(AppModel.self) private var model

    var body: some View {
        let withSpaces = home.profilesWithSpaces
        let selection = Binding(get: { choice }, set: { model.choose($0) })
        Section {
            ForEach(profiles) { profile in
                Toggle(isOn: selection.isChosen(.profile(profile.id))) {
                    Label {
                        MenuRowWords(profile.name, line: ProfileWaiting.note(for: profile, in: home))
                    } icon: {
                        MenuMark(image: ProfileMark.image(profile))
                    }
                }
                .disabled(!withSpaces.contains(profile.id))
            }
        }
        Section {
            Toggle(isOn: selection.isChosen(.all)) {
                Label {
                    MenuRowWords("All profiles", line: home.needsYou.isEmpty ? nil : ProfileWaiting.needYou(home.needsYou.count))
                } icon: {
                    Image(systemName: "square.stack")
                }
            }
        }
    }
}

/// A profile's mark, as the Mac reads it: one of the glyphs, or an emoji. Two of the profile picker's
/// glyphs are no space's, so the phone has no drawing of them and takes the system's nearest; a
/// picture of the person's own, which the phone is not sent, or a glyph it does not know, is a
/// person's outline, as a new profile's is.
enum ProfileMark: Equatable {
    case glyph(String)
    case symbol(String)
    case emoji(String)

    static let person = "person.crop.circle"
    /// The profile picker's glyphs (`PROFILE_ICONS` on the Mac) that no space has.
    static let symbols = ["user": person, "code": "chevron.left.forwardslash.chevron.right"]

    init(_ profile: Profile) {
        if profile.iconKind == .emoji, let emoji = profile.emoji, !emoji.isEmpty {
            self = .emoji(emoji)
        } else if profile.iconKind == .glyph, let glyph = profile.glyph, Marks.spaces.contains(glyph) {
            self = .glyph(glyph)
        } else if profile.iconKind == .glyph, let glyph = profile.glyph, let symbol = Self.symbols[glyph] {
            self = .symbol(symbol)
        } else {
            self = .symbol(Self.person)
        }
    }

    /// The mark as an image: a glyph in the profile's colour, as the Mac's
    /// switcher draws it, and an emoji drawn into one.
    static func image(_ profile: Profile) -> Image {
        let color = SpaceTint.color(profile.color).map(UIColor.init)
        switch ProfileMark(profile) {
        case .glyph(let name): return tinted(UIImage(named: "Spaces/\(name)"), color)
        case .symbol(let name): return tinted(UIImage(systemName: name), color)
        case .emoji(let emoji): return Image(uiImage: drawn(emoji)).renderingMode(.original)
        }
    }

    static func tinted(_ image: UIImage?, _ color: UIColor?) -> Image {
        guard let image else { return Image(systemName: person) }
        guard let color else { return Image(uiImage: image) }
        return Image(uiImage: image.withTintColor(color, renderingMode: .alwaysOriginal))
    }

    /// An emoji at a menu's glyph size.
    static func drawn(_ emoji: String) -> UIImage {
        let text = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: 17)])
        let size = text.size()
        return UIGraphicsImageRenderer(size: size).image { _ in text.draw(at: .zero) }
    }
}

/// How Home lists its sessions, from the bar: the list style, the order of the spaces where it lists
/// by space, and whether Needs you heads it.
struct ViewOptionsMenu: View {
    @AppStorage(ListOptions.Key.style) private var style = ListOptions().style
    @AppStorage(ListOptions.Key.spaceOrder) private var spaceOrder = ListOptions().spaceOrder
    @AppStorage(ListOptions.Key.needsYouFirst) private var needsYouFirst = ListOptions().needsYouFirst

    var body: some View {
        RealmMenu("View options") {
            Section(head: "List") {
                ForEach(ListStyle.allCases) { option in
                    Toggle(isOn: $style.isChosen(option)) {
                        Label(option.title, systemImage: option.symbol)
                    }
                }
            }
            if style == .bySpace {
                Section(head: "Order spaces") {
                    ForEach(SpaceOrder.allCases) { order in
                        Toggle(isOn: $spaceOrder.isChosen(order)) {
                            Label(order.title, systemImage: order.symbol)
                        }
                    }
                }
            }
            // Every item wears a glyph, so the menu's words start at one edge.
            Section {
                Toggle(isOn: $needsYouFirst) {
                    Label("Needs you first", systemImage: "hand.raised")
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.ink2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("View options")
        .accessibilityIdentifier("view-options")
    }
}

extension Binding where Value: Equatable & Sendable {
    /// One of this choice's options, as a menu's row checks it: on while it is the one chosen, and
    /// choosing it when pressed.
    func isChosen(_ option: Value) -> Binding<Bool> {
        Binding<Bool>(get: { wrappedValue == option }, set: { if $0 { wrappedValue = option } })
    }
}

/// Home's search field, there only once the bar's Search asks for it, as Manus's is; closed, it clears
/// what was typed and goes again.
private struct SearchWhenAsked: ViewModifier {
    @Binding var query: String
    @Binding var searching: Bool

    func body(content: Content) -> some View {
        content.safeAreaBar(edge: .bottom) {
            if searching {
                SearchBar(prompt: "Search sessions", query: $query, focusesFirst: true) {
                    query = ""
                    searching = false
                }
            }
        }
    }
}

/// A search field at the foot, where iOS keeps its own, drawn on Realm's ground: the field on a card's
/// capsule and the close beside it on a card's circle, both lifted as the composer is. The close shows
/// while there is a search to end.
struct SearchBar: View {
    let prompt: String
    @Binding var query: String
    var focusesFirst = false
    let close: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Palette.ink2)
                    .accessibilityHidden(true)
                TextField(prompt, text: $query, prompt: Text(prompt).foregroundStyle(Palette.ink3))
                    .focused($focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityAddTraits(.isSearchField)
                if !query.isEmpty {
                    Button("Clear text", systemImage: "xmark.circle.fill") { query = "" }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(Fill.card, in: Capsule())
            .floatingLift()
            if focused || !query.isEmpty {
                Button("Close", systemImage: "xmark") {
                    focused = false
                    close()
                }
                .labelStyle(.iconOnly)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 48, height: 48)
                .background(Fill.card, in: Circle())
                .floatingLift()
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(Motion.animation(reduceMotion), value: focused || !query.isEmpty)
        .onAppear { if focusesFirst { focused = true } }
    }
}

/// A session on Home: opens it, and pins, renames, archives or stops it from a swipe or a
/// press-and-hold. A plain press rather than a link, so the row ends at its time, as Manus's rows do,
/// with no chevron after it.
struct SessionLink: View {
    let row: SessionRow
    /// The row's space, where no section names it.
    let space: Space?
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            // A lead whose sub-agent waits opens on that sub-agent's request, the way back to the lead.
            model.path.append(contentsOf: (RowSubagents(row)?.opens ?? [row.id]).map(Route.session))
        } label: {
            SessionRowView(row: row, space: space)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        // Manus's list rests on space between its rows, not lines.
        .listRowSeparator(.hidden)
        .sessionRowActions(row)
        .accessibilityIdentifier("session-\(row.id)")
    }
}

/// One session, as Manus lists a task: a round tile with its space's mark (or the agent's, where the
/// section names the space), ringed while a turn works and dotted while it waits on you;
/// its title on one line, with its age at the end; and under it a quiet line — the state worth acting
/// on, else what it is about.
struct SessionRowView: View {
    let row: SessionRow
    let space: Space?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let state = RowState(row)
        HStack(alignment: .center, spacing: 12) {
            RowTile(row: row, space: space, state: state)
            VStack(alignment: .leading, spacing: 3) {
                let line = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                line {
                    Text(row.displayTitle)
                        .font(.body.weight(row.unread ? .semibold : .medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 1)
                        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
                    HStack(spacing: 4) {
                        if row.pinned == true {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(Palette.ink3)
                        }
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(Ago.text(row.lastActivity, now: context.date))
                                .font(.footnote)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink3)
                        }
                    }
                    .fixedSize()
                }
                let about = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(spacing: 6))
                about {
                    if let state {
                        StateWord(state: state)
                    } else {
                        RowAbout(row: row, space: space)
                    }
                    if row.scheduled == true {
                        ScheduledRunMark(dotted: !dynamicTypeSize.isAccessibilitySize)
                    }
                    if let subagents = RowSubagents(row), subagents.waiting == 0 {
                        SubagentCount(words: subagents.words, dotted: !dynamicTypeSize.isAccessibilitySize)
                    }
                    if let goal = row.shownGoal {
                        RowGoal(goal: goal, dotted: !dynamicTypeSize.isAccessibilitySize)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.spoken(row))
        .accessibilityHint("Opens the session")
    }

    /// What VoiceOver says for a row: the title first, then everything the row shows, in words. The
    /// space is said on every row, since a row is read without the section's head above it.
    static func spoken(_ row: SessionRow, now: Date = Date()) -> String {
        var parts = [row.displayTitle]
        if let state = RowState(row) { parts.append(state.word) }
        if row.scheduled == true { parts.append("Scheduled run") }
        if let subagents = RowSubagents(row), subagents.waiting == 0 { parts.append(subagents.words) }
        if let goal = row.shownGoal { parts.append("Goal \(goal.status.label)") }
        if row.unread { parts.append("Unread") }
        if row.pinned == true { parts.append("Pinned") }
        parts.append(contentsOf: [row.spaceName, row.agentDisplayName].filter { !$0.isEmpty })
        if let model = row.modelDisplayName, !model.isEmpty { parts.append(model) }
        parts.append(Ago.text(row.lastActivity, now: now))
        return parts.joined(separator: ", ")
    }
}

/// A row's round tile, as Manus marks a task: the space's mark, or the agent's where the section
/// names the space, and a quiet ring while a turn works. A row that waits on you says it once, in its
/// words and their hand, as the Mac's sidebar row says it with one dot: the tile wears no dot of its
/// own. Unread is the title's weight, never a dot.
private struct RowTile: View {
    let row: SessionRow
    let space: Space?
    let state: RowState?
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(Fill.pill)
            if let space {
                SpaceGlyph(space: space, size: 18, relativeTo: .body)
            } else {
                AgentMark(kind: row.agent, mark: row.agentMark, colored: true, size: 18, relativeTo: .body)
            }
        }
        .frame(width: side, height: side)
        .overlay {
            if state == .working {
                Circle()
                    .strokeBorder(Tone.working.agentColor, lineWidth: 1.5)
                    .restingPulse(when: true)
            }
        }
        .accessibilityHidden(true)
    }
}

/// What a session is about, in one quiet line: its space where no section names it, then the agent's
/// mark and its model. Where it does not fit, the model yields first, then the space.
private struct RowAbout: View {
    let row: SessionRow
    let space: Space?

    var body: some View {
        HStack(spacing: 6) {
            if let space {
                HStack(spacing: 4) {
                    SpaceGlyph(space: space, size: 13, relativeTo: .footnote)
                    Text(space.name)
                        .lineLimit(1)
                }
                .layoutPriority(2)
                Text("·")
                    .accessibilityHidden(true)
            }
            HStack(spacing: 4) {
                AgentMark(kind: row.agent, mark: row.agentMark, size: 12, relativeTo: .footnote)
                Text(row.modelDisplayName ?? row.agentDisplayName)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .layoutPriority(1)
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink2)
        .accessibilityHidden(true)
    }
}

/// A session a scheduled task's run started, said after what the line says of it, as the desktop's
/// row wears the schedule's clock: two runs of a task, or a run and the session it is named like,
/// read apart. It keeps its words, and the model beside it yields first.
private struct ScheduledRunMark: View {
    /// After the line's other words; on a line of its own at the accessibility sizes.
    let dotted: Bool

    var body: some View {
        HStack(spacing: 6) {
            if dotted { Text("·") }
            HStack(spacing: 3) {
                Image(systemName: "clock")
                    .font(.caption)
                Text("Scheduled run")
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink2)
        // On a line of its own at the accessibility sizes, it wraps rather than run past the row's edge.
        .fixedSize(horizontal: dotted, vertical: true)
        .accessibilityHidden(true)
    }
}

/// How many sub-agents a lead's row holds, after what the line says of the session itself: the count
/// keeps its place, and the model beside it yields first.
private struct SubagentCount: View {
    let words: String
    /// After the line's other words; on a line of its own at the accessibility sizes.
    let dotted: Bool

    var body: some View {
        HStack(spacing: 6) {
            if dotted { Text("·") }
            HStack(spacing: 3) {
                Image(systemName: "person.2")
                    .font(.caption)
                Text(words)
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink2)
        .fixedSize()
        .layoutPriority(3)
        .accessibilityHidden(true)
    }
}

/// A row's state as its glyph and its word, bold: amber where it needs you or failed, else the quiet
/// ink, and never colour alone.
struct StateWord: View {
    let state: RowState
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: state.symbol)
                .symbolRenderingMode(.hierarchical)
                .restingPulse(when: state == .working)
            Text(state.word)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(state.tone.agentColor)
        // On a line of its own at the accessibility sizes, it wraps rather than run past the row's edge.
        .fixedSize(horizontal: !dynamicTypeSize.isAccessibilitySize, vertical: true)
        .accessibilityHidden(true)
    }
}

/// A session with something not yet gone to the Mac — a message or an answer kept while the Mac was
/// away, or one the Mac refused — gathered at the head of Home so none of it is out of sight.
struct UnsentSession: Identifiable, Equatable {
    let id: String
    let title: String
    let items: [OutgoingItem]

    /// What has not gone, by session, in the order it was given. While the Mac is connected, only what
    /// it refused: everything else is on its way.
    static func list(outbox: Outbox, home: Home?, connected: Bool) -> [UnsentSession] {
        let held = outbox.items.filter { item in
            if item.isFailed { return true }
            return !connected && (item.state == .waiting || item.state == .unconfirmed)
        }
        let rows = (home?.needsYou ?? []) + (home?.spaces.flatMap(\.sessions) ?? []) + (home?.recent ?? [])
        let titles = Dictionary(rows.map { ($0.id, $0.displayTitle) }, uniquingKeysWith: { first, _ in first })
        var order: [String] = []
        var bySession: [String: [OutgoingItem]] = [:]
        for item in held {
            if bySession[item.sessionId] == nil { order.append(item.sessionId) }
            bySession[item.sessionId, default: []].append(item)
        }
        return order.map { UnsentSession(id: $0, title: titles[$0] ?? "A session", items: bySession[$0] ?? []) }
    }

    /// "2 messages and an answer".
    var what: String {
        let messages = items.filter(\.isMessage).count
        let answers = items.count - messages
        var parts: [String] = []
        if messages > 0 { parts.append(messages == 1 ? "A message" : "\(messages) messages") }
        if answers > 0 { parts.append(answers == 1 ? (parts.isEmpty ? "An answer" : "an answer") : "\(answers) answers") }
        return parts.joined(separator: " and ")
    }
}

private struct UnsentRow: View {
    let session: UnsentSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let refused = session.items.first { $0.isFailed }
        NavigationLink(value: Route.session(session.id)) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: refused == nil ? "clock.arrow.circlepath" : "exclamationmark.circle.fill")
                    .foregroundStyle(refused == nil ? Palette.ink2 : Tone.failed.agentColor)
                    .frame(width: 9)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    Text(detail(refused))
                        .font(.footnote)
                        .foregroundStyle(refused == nil ? Palette.ink2 : Tone.failed.agentColor)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, 6)
        }
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Palette.divider)
        .accessibilityElement(children: .combine)
    }

    private func detail(_ refused: OutgoingItem?) -> String {
        if let refused, case .failed(let reason) = refused.state { return "Not sent. \(reason)" }
        return "\(session.what) · \(model.linkStatus.waitingNote)"
    }
}

/// Before the Mac has sent anything: rows the shape of the ones on their way.
private struct LoadingSections: View {
    static let placeholder = SessionRow(id: "placeholder", title: "A session on its way here from the Mac", spaceId: "",
                                        spaceName: "", agent: "", model: "model", status: .idle, needsYou: false, unread: false,
                                        updatedAt: Date().timeIntervalSince1970 * 1000)

    var body: some View {
        ForEach(0..<2) { section in
            Section {
                ForEach(0..<(section == 0 ? 2 : 4), id: \.self) { _ in
                    SessionRowView(row: Self.placeholder, space: nil)
                        .listRowBackground(Color.clear)
                }
            } header: {
                Text("A space")
                    .font(.subheadline.weight(.semibold))
                    .textCase(nil)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

/// Before the Mac has sent anything, and the Mac is away: what is the matter, in words, and what to do.
private struct FirstLoad: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.shownLinkStatus
        let mac = model.store.pairedMac?.macName ?? "Your Mac"
        switch status.kind {
        case .connected, .connecting:
            EmptyView()
        case .asleep:
            EmptyState(mac, systemImage: "laptopcomputer", description: "\(status.words). While your Mac sleeps, this iPhone cannot reach it.") {
                RetryButton()
            }
        case .relayUnreachable:
            EmptyState("Can't reach the relay", systemImage: "wifi.exclamationmark", description: "Check this iPhone's connection. Realm keeps trying.") {
                RetryButton()
            }
        case .notAnswering:
            EmptyState("\(mac) is not answering", systemImage: "laptopcomputer.trianglebadge.exclamationmark", description: "Check that Realm is open on your Mac. This iPhone keeps trying.") {
                RetryButton()
            }
        case .refused(let reason):
            EmptyState(reason, systemImage: "xmark.octagon", description: "To see its sessions again, make a pairing code in Settings ▸ Devices on your Mac and scan it here.") {
                Button("Pair again") { model.pairingRequested = true }
                    .buttonStyle(InkButtonStyle())
            }
        case .notConnected:
            EmptyState("Not connected", systemImage: "pause.circle", description: "This iPhone connects to \(mac) while Realm is open.") {
                RetryButton()
            }
        }
    }
}

/// A new attempt now, rather than at the end of the wait between tries.
private struct RetryButton: View {
    @Environment(AppModel.self) private var model
    @State private var trying = false

    var body: some View {
        Button {
            Task {
                trying = true
                await model.refresh()
                trying = false
            }
        } label: {
            HStack(spacing: 6) {
                if trying { ProgressView().controlSize(.small).tint(Fill.onPrimary) }
                Text(trying ? "Reconnecting…" : "Reconnect")
            }
        }
        .buttonStyle(InkButtonStyle())
        .disabled(trying)
    }
}

/// A search that found nothing, and why the list it searched may be shorter than the Mac's.
struct NoResults: View {
    let query: String
    let why: String

    var body: some View {
        EmptyState("No results for “\(query)”", systemImage: "magnifyingglass", description: why)
    }

    /// The Mac's search found nothing.
    static let macWords = "No session on your Mac has it in its title or its messages."

    /// Home's reason, for the style it lists in; `pages` where a space's page lists the rest of its sessions.
    static func words(style: ListStyle, pages: Bool) -> String {
        let listed = style == .bySpace ? "each space's latest" : "the most recent"
        let rest = pages ? "Each space's page lists all of its sessions." : "The rest are on your Mac."
        return "This searches the sessions listed here: \(listed). \(rest)"
    }
}

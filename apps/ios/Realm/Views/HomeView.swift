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
    @State private var filter = HomeFilter.all
    @State private var reconnecting = false
    @State private var newSessionShown = false
    /// The moment By day reckons its days from, moved on at midnight and on coming back to the app.
    @State private var now = Date()
    @Namespace private var settingsZoom

    var body: some View {
        @Bindable var model = model
        let home = model.store.home.map { model.rowEdits.applied(to: $0) }
        let choice = model.profileChoice
        let options = ListOptions(style: style, spaceOrder: spaceOrder, needsYouFirst: needsYouFirst)
        let listing = home.map { HomeListing(home: $0, choice: choice, options: options, query: query, now: now) }
        let unsent = UnsentSession.list(outbox: model.store.outbox, home: home, connected: model.isConnected)
        let shown = model.shownLinkStatus
        // A Mac that names its profiles pages a space's sessions too; an older one has only Home's few.
        let pages = home?.profiles != nil
        List {
            if let listing {
                ForEach(listing.elsewhere) { waiting in
                    ElsewhereRow(waiting: waiting)
                }
                if filter == .all {
                    WorkHeadLines(searching: listing.isFiltered)
                }
                if !listing.needsYou.isEmpty, filter != .pinned {
                    Section {
                        // A session that needs you is listed in its space too: each row has its
                        // section's identity, or the list draws one of the two as a hole.
                        ForEach(listing.needsYou, id: \.needsYouKey) { row in
                            SessionLink(row: row, space: listing.space(of: row))
                        }
                    } header: {
                        SectionHead(title: "Needs you") {
                            Image(systemName: "hand.raised.fill").foregroundStyle(Palette.orange)
                        }
                        .headOnGround()
                    }
                    .listSectionSeparator(.hidden)
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
                        .headOnGround()
                    }
                    .listSectionSeparator(.hidden)
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
                        .headOnGround()
                    }
                    .listSectionSeparator(.hidden)
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
                            .headOnGround()
                    }
                    .listSectionSeparator(.hidden)
                }
            } else if shown.kind == .connecting || shown.kind == .connected {
                LoadingSections()
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .id(ListIdentity(choice: choice, style: style))
        // Manus's chips under the bar: what the list holds, by what it asks of the person.
        .safeAreaInset(edge: .top, spacing: 0) {
            if let listing {
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
            } else if let listing, listing.isEmpty, unsent.isEmpty {
                if listing.isFiltered {
                    NoResults(query: query, why: NoResults.words(style: style, pages: pages))
                } else {
                    ContentUnavailableView(choice.emptyWords(in: home), systemImage: "text.bubble",
                                           description: Text("Start one in Realm on your Mac, and it shows here."))
                }
            }
        }
        .navigationTitle(choice.title(in: home))
        .navigationBarTitleDisplayMode(.inline)
        .navigationSubtitle(MacLine.text(model: model, compact: dynamicTypeSize.isAccessibilitySize))
        .modifier(ProfileSwitcher(home: home, choice: choice))
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
            .matchedTransitionSource(id: "settings", in: settingsZoom)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    searching = true
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .accessibilityIdentifier("search")
            }
        }
        .modifier(SearchWhenAsked(query: $query, searching: $searching))
        .refreshable { await model.refresh() }
        .sheet(isPresented: $model.settingsShown) {
            SettingsSheet()
                .navigationTransition(.zoom(sourceID: "settings", in: settingsZoom))
        }
        .sheet(isPresented: $newSessionShown) {
            NewSessionSheet()
                .navigationTransition(.zoom(sourceID: "new-session", in: settingsZoom))
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
        return Text("\(Text(Image(systemName: status.kind.glyph)).foregroundStyle(status.kind.tone.color)) \(words)")
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
    var isWorking: Bool { status == .running || status == .waiting }
}

/// What a row says about its session, at the end of its first line: the state a person would act on
/// or want to know, as a glyph and a word in its tone. A session at rest says nothing, and its row
/// shows how long ago it moved instead.
enum RowState: Equatable {
    case waiting, working, failed, done

    init?(_ row: SessionRow) {
        switch row.status {
        case .waiting: self = .waiting
        case .running: self = .working
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
        }
    }

    var symbol: String {
        switch self {
        case .waiting: "hand.raised.fill"
        case .working: "progress.indicator"
        case .failed: "exclamationmark.circle.fill"
        case .done: "checkmark.circle.fill"
        }
    }

    var tone: Tone {
        switch self {
        case .waiting: .waiting
        case .working: .working
        case .failed: .failed
        case .done: .done
        }
    }
}

/// A section's name in sentence case beside its glyph, at the list's head rung.
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
        .padding(.top, 6)
    }
}

extension View {
    /// A section's head on the list's own ground, edge to edge, as the bar above it is. Pinned while
    /// its rows scroll under it, it stays the bar's colour, rather than a band of material with a line
    /// under it.
    func headOnGround() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .background(Ground.transcript)
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
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
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
                        .foregroundStyle(Palette.accentInk)
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
        HeadLine(symbol: "hand.raised.fill", tone: Palette.orange, words: waiting.words) {
            model.choose(.profile(waiting.profile.id))
        }
        .accessibilityHint("Shows \(waiting.profile.name)")
        .accessibilityIdentifier("elsewhere-\(waiting.profile.id)")
    }
}

/// The title opens the menu of profiles while the Mac has more than one; with one, or none it says,
/// there is nothing to switch, and no chevron says otherwise.
private struct ProfileSwitcher: ViewModifier {
    let home: Home?
    let choice: ProfileChoice

    func body(content: Content) -> some View {
        if let home, let profiles = home.profilesToSwitch {
            content.toolbarTitleMenu { ProfileMenu(home: home, profiles: profiles, choice: choice) }
        } else {
            content
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
        ForEach(profiles) { profile in
            Toggle(isOn: selection.isChosen(.profile(profile.id))) {
                Self.item(profile.name, note: ProfileWaiting.note(for: profile, in: home), mark: ProfileMark.image(profile))
            }
            .disabled(!withSpaces.contains(profile.id))
        }
        Toggle(isOn: selection.isChosen(.all)) {
            Self.item("All profiles", note: home.needsYou.isEmpty ? nil : ProfileWaiting.needYou(home.needsYou.count),
                      mark: Image(systemName: "square.stack"))
        }
    }

    /// A menu draws an item's second text as the line under its name, and its image as its mark — but
    /// not from inside a label, so neither is wrapped in one.
    @ViewBuilder
    private static func item(_ name: String, note: String?, mark: Image) -> some View {
        if let note {
            Text(name)
            Text(note)
            mark
        } else {
            Text(name)
            mark
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

    /// The mark as an image, which is all a menu draws: a glyph in the profile's colour, as the Mac's
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
        Menu {
            Section("List") {
                ForEach(ListStyle.allCases) { option in
                    Toggle(isOn: $style.isChosen(option)) {
                        Label(option.title, systemImage: option.symbol)
                    }
                }
            }
            if style == .bySpace {
                Section("Order spaces") {
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
                .frame(width: 44, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("View options")
        .accessibilityIdentifier("view-options")
    }
}

extension Binding where Value: Equatable & Sendable {
    /// One of this choice's options, as a menu checks it: on while it is the one chosen, and choosing
    /// it when pressed. A picker says the same, but a menu draws a picker's options with no title over
    /// them and no second line under each.
    func isChosen(_ option: Value) -> Binding<Bool> {
        Binding<Bool>(get: { wrappedValue == option }, set: { if $0 { wrappedValue = option } })
    }
}

/// The search field under Home's bar, there only once the bar's Search asks for it, as Manus's is;
/// cancelled with nothing typed, it goes again.
private struct SearchWhenAsked: ViewModifier {
    @Binding var query: String
    @Binding var searching: Bool
    @State private var shown = false

    func body(content: Content) -> some View {
        Group {
            if shown {
                content.searchable(text: $query, isPresented: $searching, placement: .navigationBarDrawer(displayMode: .always),
                                   prompt: "Search sessions")
            } else {
                content
            }
        }
        .onChange(of: searching) { _, now in
            if now { shown = true } else if query.isEmpty { shown = false }
        }
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
            model.path.append(Route.session(row.id))
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
/// section names the space), ringed while a turn works and dotted while it waits on you or is unread;
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
                if let state {
                    StateWord(state: state)
                } else {
                    RowAbout(row: row, space: space)
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
        if row.unread { parts.append("Unread") }
        if row.pinned == true { parts.append("Pinned") }
        parts.append(contentsOf: [row.spaceName, row.agentDisplayName].filter { !$0.isEmpty })
        if let model = row.modelDisplayName, !model.isEmpty { parts.append(model) }
        parts.append(Ago.text(row.lastActivity, now: now))
        return parts.joined(separator: ", ")
    }
}

/// A row's round tile, as Manus marks a task: the space's mark, or the agent's where the section
/// names the space; a ring of the accent while a turn works, and a dot — orange while it waits on
/// you, the accent while it is unread — at its corner, each beside the words that say it too.
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
                    .strokeBorder(Palette.accent, lineWidth: 2)
                    .restingPulse(when: true)
            }
        }
        .overlay(alignment: .topTrailing) {
            if state == .waiting || row.unread {
                Circle()
                    .fill(state == .waiting ? Palette.orange : Palette.accent)
                    .frame(width: 11, height: 11)
                    .overlay(Circle().strokeBorder(Ground.transcript, lineWidth: 2))
                    .offset(x: 1, y: -1)
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

/// A row's state as its glyph and its word, bold, in its tone: never colour alone.
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
        .foregroundStyle(state.tone.color)
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
                    .foregroundStyle(refused == nil ? Palette.ink2 : Palette.red)
                    .frame(width: 9)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    Text(detail(refused))
                        .font(.footnote)
                        .foregroundStyle(refused == nil ? Palette.ink2 : Palette.red)
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
            ContentUnavailableView {
                Label(mac, systemImage: "laptopcomputer")
            } description: {
                Text("\(status.words). While your Mac sleeps, this iPhone cannot reach it.")
            } actions: {
                RetryButton()
            }
        case .relayUnreachable:
            ContentUnavailableView {
                Label("Can't reach the relay", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Check this iPhone's connection. Realm keeps trying.")
            } actions: {
                RetryButton()
            }
        case .notAnswering:
            ContentUnavailableView {
                Label("\(mac) is not answering", systemImage: "laptopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text("The relay can reach it, and Realm on it did not answer. Realm keeps trying.")
            } actions: {
                RetryButton()
            }
        case .refused(let reason):
            ContentUnavailableView {
                Label(reason, systemImage: "xmark.octagon")
            } description: {
                Text("To see its sessions again, make a pairing code in Settings ▸ Devices on your Mac and scan it here.")
            } actions: {
                Button("Pair again") { model.pairingRequested = true }
                    .buttonStyle(InkButtonStyle())
            }
        case .notConnected:
            ContentUnavailableView {
                Label("Not connected", systemImage: "pause.circle")
            } description: {
                Text("This iPhone connects to \(mac) while Realm is open.")
            } actions: {
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
        ContentUnavailableView {
            Label("No results for “\(query)”", systemImage: "magnifyingglass")
        } description: {
            Text(why)
        }
    }

    /// Home's reason, for the style it lists in; `pages` where a space's page lists the rest of its sessions.
    static func words(style: ListStyle, pages: Bool) -> String {
        let listed = style == .bySpace ? "each space's latest" : "the most recent"
        let rest = pages ? "Each space's page lists all of its sessions." : "The rest are on your Mac."
        return "This searches the sessions listed here: \(listed). \(rest)"
    }
}

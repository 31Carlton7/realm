import RealmKit
import SwiftUI

/// The sidebar's answer to "what should I look at": what needs you, then each space's sessions by
/// activity. Under the title, the Mac and its state.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var query = ""
    @Namespace private var settingsZoom

    var body: some View {
        @Bindable var model = model
        let home = model.store.home
        let sections = home.map { HomeSections(home: $0, query: query) }
        List {
            if case .refused(_, let reason) = model.store.connection, home != nil {
                Section { RefusedCard(reason: reason) }
            }
            if let savedAt = model.store.homeSavedAt, home != nil {
                Section {} header: { LastUpdated(savedAt: savedAt) }
            }
            if let sections {
                if !sections.needsYou.isEmpty {
                    Section {
                        // A session that needs you is listed in its space too: each row has its
                        // section's identity, or the list draws one of the two as a hole.
                        ForEach(sections.needsYou, id: \.needsYouKey) { row in
                            SessionLink(row: row, space: sections.space(of: row))
                        }
                    } header: {
                        SectionHead(title: "Needs you") {
                            Image(systemName: "hand.raised.fill").foregroundStyle(Palette.orange)
                        }
                    }
                }
                ForEach(sections.spaces) { space in
                    Section {
                        ForEach(space.sessions) { row in
                            SessionLink(row: row, space: nil)
                        }
                    } header: {
                        SectionHead(title: space.name) { SpaceGlyph(space: space) }
                    } footer: {
                        SpaceFooter(space: space, searching: sections.isFiltered)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
        .overlay {
            if home == nil {
                FirstLoad()
            } else if let sections, sections.isEmpty {
                if sections.isFiltered {
                    NoResults(query: query)
                } else {
                    ContentUnavailableView("No spaces yet", systemImage: "square.stack.3d.up",
                                           description: Text("Make one in Realm on your Mac, and its sessions show here."))
                }
            }
        }
        .navigationTitle("Sessions")
        .navigationSubtitle(dynamicTypeSize.isAccessibilitySize ? model.linkStatus.words : model.macLine)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.settingsShown = true
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .accessibilityIdentifier("settings")
            }
            .matchedTransitionSource(id: "settings", in: settingsZoom)
        }
        .searchable(text: $query, prompt: "Search sessions")
        .refreshable { await model.refresh() }
        .sheet(isPresented: $model.settingsShown) {
            SettingsSheet()
                .navigationTransition(.zoom(sourceID: "settings", in: settingsZoom))
        }
    }
}

/// What Home lists, narrowed by a search: the Needs-you rows and each space's, matched on the
/// session's title, its space and its agent.
struct HomeSections {
    let needsYou: [SessionRow]
    let spaces: [Space]
    let isFiltered: Bool
    private let spacesById: [String: Space]

    init(home: Home, query: String) {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        isFiltered = !words.isEmpty
        spacesById = Dictionary(home.spaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard isFiltered else {
            needsYou = home.needsYou
            spaces = home.spaces
            return
        }
        let matches = { (row: SessionRow) in
            [row.title, row.spaceName, AgentNames.label(row.agent)].contains { $0.localizedStandardContains(words) }
        }
        needsYou = home.needsYou.filter(matches)
        spaces = home.spaces.compactMap { space in
            let rows = space.sessions.filter(matches)
            return rows.isEmpty ? nil
                : Space(id: space.id, name: space.name, icon: space.icon, color: space.color, sessions: rows, more: space.more)
        }
    }

    /// The space a Needs-you row belongs to, for its glyph and colour.
    func space(of row: SessionRow) -> Space? {
        spacesById[row.spaceId]
    }

    var isEmpty: Bool {
        needsYou.isEmpty && spaces.isEmpty
    }
}

extension SessionRow {
    /// A Needs-you row's identity, apart from the same session's row in its space.
    var needsYouKey: String { "needs-you/\(id)" }

    var displayTitle: String { title.isEmpty ? "Untitled session" : title }
}

/// A section's name in sentence case beside its glyph, at the list's head rung.
struct SectionHead<Glyph: View>: View {
    let title: String
    @ViewBuilder let glyph: Glyph

    var body: some View {
        HStack(spacing: 7) {
            glyph
                .accessibilityHidden(true)
            Text(title)
                .lineLimit(2)
                .accessibilityAddTraits(.isHeader)
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Palette.ink)
        .textCase(nil)
    }
}

/// Under a space: how many more of its sessions the Mac holds, or that it has none yet.
private struct SpaceFooter: View {
    let space: Space
    let searching: Bool

    var body: some View {
        if space.sessions.isEmpty {
            Text("No sessions yet")
        } else if space.more > 0, !searching {
            Text("\(space.more) more on your Mac")
        }
    }
}

/// A session on Home: opens it, and stops its turn from a swipe or a press-and-hold.
private struct SessionLink: View {
    let row: SessionRow
    /// The row's space, where no section names it (Needs you).
    let space: Space?
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationLink(value: Route.session(row.id)) {
            SessionRowView(row: row, space: space)
        }
        .listRowBackground(Fill.card)
        .listRowSeparatorTint(Palette.divider)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if row.isWorking {
                Button("Stop", systemImage: "stop.fill") { Task { await model.stop(row.id) } }
                    .tint(Palette.ink2)
            }
        }
        .contextMenu {
            if row.isWorking {
                Button("Stop", systemImage: "stop.fill") { Task { await model.stop(row.id) } }
            }
        }
        .accessibilityActions {
            if row.isWorking {
                Button("Stop") { Task { await model.stop(row.id) } }
            }
        }
        .accessibilityIdentifier("session-\(row.id)")
    }
}

extension SessionRow {
    /// A turn is under way, or waits on the person: Stop has something to stop.
    var isWorking: Bool { status == .running || status == .waiting }
}

/// One session: its title and how long ago it moved, then its status as a word and a glyph, the
/// agent's mark and the model. A Needs-you row says its space first, as Mail says the sender.
struct SessionRowView: View {
    let row: SessionRow
    let space: Space?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At the accessibility sizes nothing shares a line with the title: each part gets the width.
        let stacked = dynamicTypeSize.isAccessibilitySize
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(row.unread ? Palette.accent : .clear)
                .frame(width: 8, height: 8)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: 4) {
                if let space {
                    HStack(spacing: 5) {
                        SpaceGlyph(space: space, size: 14, relativeTo: .footnote)
                        Text(space.name)
                            .lineLimit(1)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink2)
                }
                let titleLine = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                titleLine {
                    Text(row.displayTitle)
                        .font(.body.weight(row.unread ? .semibold : .regular))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(stacked ? 6 : 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(Ago.text(row.updatedAt, now: context.date))
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(Palette.ink2)
                    }
                    .fixedSize()
                }
                let detailLine = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))
                detailLine {
                    StatusLabel(status: row.status)
                        .fixedSize(horizontal: !stacked, vertical: true)
                    AgentLabel(agent: row.agent, model: row.model)
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.spoken(row))
        .accessibilityHint("Opens the session")
    }

    /// What VoiceOver says for a row: the title first, then everything the row shows, in words. The
    /// space is said on every row, since a row is read without the section's head above it.
    static func spoken(_ row: SessionRow, now: Date = Date()) -> String {
        var parts = [row.displayTitle, row.status.word]
        if row.unread { parts.append("Unread") }
        parts.append(contentsOf: [row.spaceName, AgentNames.label(row.agent)].filter { !$0.isEmpty })
        if let model = row.model, !model.isEmpty { parts.append(model) }
        parts.append(Ago.text(row.updatedAt, now: now))
        return parts.joined(separator: ", ")
    }
}

/// A status as its glyph and its word, in its tone: never colour alone.
struct StatusLabel: View {
    let status: SessionStatus

    var body: some View {
        HStack(spacing: 5) {
            StatusGlyph(status: status)
            Text(status.word)
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(status.tone.color)
        .accessibilityElement(children: .combine)
    }
}

/// The agent's mark and the model it runs, in mono; the agent's name where there is no model to show.
/// It is one line and yields from its end.
struct AgentLabel: View {
    let agent: String
    let model: String?
    var style: Font.TextStyle = .footnote

    var body: some View {
        HStack(spacing: 5) {
            AgentMark(kind: agent, size: 13, relativeTo: style)
            if let model, !model.isEmpty {
                Text(model)
                    .mono(style)
            } else {
                Text(AgentNames.label(agent))
                    .font(.system(style))
            }
        }
        .foregroundStyle(Palette.ink2)
        .lineLimit(1)
        .truncationMode(.middle)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([AgentNames.label(agent), model ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// "Last updated 10:42": what is on screen came from this iPhone's copy, or from before the
/// connection went.
struct LastUpdated: View {
    let savedAt: Date

    var body: some View {
        Label {
            Text("Last updated \(LinkStatus.moment(savedAt, now: Date(), calendar: .current, locale: .current))")
        } icon: {
            Image(systemName: "clock.arrow.circlepath")
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink2)
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }
}

/// The Mac or the relay turned this iPhone away. A decision, so it stays until it is answered.
struct RefusedCard: View {
    let reason: String
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(reason)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
            } icon: {
                Image(systemName: "xmark.octagon.fill")
                    .foregroundStyle(Palette.red)
            }
            Text("To see its sessions again, make a pairing code in Settings ▸ Devices on your Mac and scan it here.")
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair again") { model.pairingRequested = true }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
        }
        .padding(.vertical, 6)
        .listRowBackground(Fill.card)
    }
}

/// Before the Mac has sent anything: what the connection is doing, in words, and what to do about it.
private struct FirstLoad: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.linkStatus
        let mac = model.store.pairedMac?.macName ?? "Your Mac"
        switch status.kind {
        case .connected, .connecting:
            ContentUnavailableView {
                VStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                    Text(status.kind == .connected ? "Loading your sessions…" : "Connecting to \(mac)…")
                        .font(.title3.weight(.semibold))
                }
            }
        case .asleep:
            ContentUnavailableView {
                Label("\(mac) is asleep", systemImage: "moon.zzz")
            } description: {
                Text("While your Mac sleeps, this iPhone cannot reach it. Its sessions show here once it wakes.")
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
                Text("The relay can reach it, and Realm on your Mac did not answer. Realm keeps trying.")
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
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
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
            if trying {
                ProgressView()
            } else {
                Text("Try again")
            }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .disabled(trying)
    }
}

/// A search that found nothing, and why the list it searched may be shorter than the Mac's.
private struct NoResults: View {
    let query: String

    var body: some View {
        ContentUnavailableView {
            Label("No results for “\(query)”", systemImage: "magnifyingglass")
        } description: {
            Text("This searches the sessions listed here: each space's latest. The rest are on your Mac.")
        }
    }
}

import RealmKit
import SwiftUI

/// Home's Team: a profile's teammates, the Lead first and then in each space's Team order, as the
/// Mac's sidebar heads each space with them. A long team shows the Lead and whoever is busy, waiting
/// on the person or unread, and the rest are a press away on the Team page; a short one shows whole.
struct TeamSection: View {
    let teammates: [Teammate]
    let spaces: [Space]
    /// The profile's teammates put away, folded at the section's end.
    var archived: [Teammate] = []
    @Environment(AppModel.self) private var model

    /// Shown whole up to this many; past it, the Lead and the busy ones.
    static let whole = 6

    var body: some View {
        let shown = Self.shown(teammates)
        Section {
            // More than one space's teammates: each space's under a quiet line naming it.
            ForEach(spaces) { space in
                let team = shown.filter { $0.spaceId == space.id }
                if spaces.count > 1, !team.isEmpty {
                    HStack(spacing: 5) {
                        SpaceGlyph(space: space, size: 13, relativeTo: .footnote)
                        Text(space.name)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink2)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 0, trailing: 20))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .accessibilityAddTraits(.isHeader)
                }
                ForEach(team) { teammate in TeammateLink(teammate: teammate) }
            }
            if shown.count < teammates.count {
                NavigationLink(value: Route.team) {
                    Text("All \(teammates.count) teammates")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityIdentifier("team-all")
            }
            if !archived.isEmpty { ArchivedTeam(teammates: archived) }
        } header: {
            HStack {
                SectionHead(title: "Team") {
                    Image(systemName: "person.2.fill").foregroundStyle(Palette.ink2)
                }
                Spacer()
                NewTeammateButton(spaceId: (teammates.first ?? archived.first)?.spaceId ?? spaces.first?.id)
            }
        }
    }

    /// Which teammates Home lists, in their order: all of a short team; of a long one the Leads and the
    /// ones with something going on, up to `whole`. Order never follows state, so a row does not jump.
    static func shown(_ teammates: [Teammate]) -> [Teammate] {
        guard teammates.count > whole else { return teammates }
        let busy = teammates.filter { $0.lead || $0.state == .working || $0.state == .needsYou || $0.unread == true }
        return Array(busy.prefix(whole))
    }
}

/// Every teammate of the profile Home shows, space by space under each space's head, and the ones put
/// away folded at the end. Edit drags a space's teammates into a new order, as the Mac's sidebar does;
/// the Lead keeps the top.
struct TeamView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let home = model.store.home
        let spaces = (home?.spaces ?? []).filter(model.profileChoice.includes)
        let teammates = model.work.teammates ?? []
        let shown = Set(spaces.map(\.id))
        let archived = model.work.archivedTeammates.filter { shown.contains($0.spaceId) }
        List {
            ForEach(spaces) { space in
                let team = teammates.filter { $0.spaceId == space.id }
                if !team.isEmpty {
                    Section {
                        ForEach(team) { teammate in
                            TeammateLink(teammate: teammate)
                                .moveDisabled(teammate.lead || !model.isConnected)
                        }
                        .onMove { from, to in
                            guard let order = TeamOrder.moved(team, from: from, to: to) else { return }
                            Task { await model.reorder(order, in: space.id) }
                        }
                    } header: {
                        SectionHead(title: space.name) { SpaceGlyph(space: space) }
                    }
                }
            }
            if !archived.isEmpty {
                Section { ArchivedTeam(teammates: archived) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .navigationTitle("Team")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NewTeammateButton(spaceId: teammates.first { shown.contains($0.spaceId) }?.spaceId ?? spaces.first?.id)
            }
            ToolbarItem(placement: .topBarTrailing) { EditButton() }
        }
        .refreshable { await model.work.loadTeam() }
    }
}

/// A space's Team after a drag: nil where nothing moved, or where it would put another above the Lead.
enum TeamOrder {
    static func moved(_ team: [Teammate], from: IndexSet, to: Int) -> [Teammate]? {
        var order = team
        order.move(fromOffsets: from, toOffset: to)
        guard order != team else { return nil }
        if let lead = team.first(where: \.lead), order.first != lead { return nil }
        return order
    }
}

/// The Team's "+": New teammate, in the space given, or the first the profile shows.
struct NewTeammateButton: View {
    let spaceId: String?
    @Environment(AppModel.self) private var model

    var body: some View {
        Button("New teammate", systemImage: "plus") { model.newTeammateSpace = spaceId }
            .labelStyle(.iconOnly)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Palette.ink2)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(spaceId == nil || !model.isConnected || model.agentList == nil)
            .accessibilityIdentifier("team-new")
    }
}

/// The teammates put away, folded under one row at the Team's end; each brought back from its menu or
/// a swipe. Put away, a teammate has no chat to open.
struct ArchivedTeam: View {
    let teammates: [Teammate]
    @State private var open = false
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            withAnimation(.snappy) { open.toggle() }
        } label: {
            HStack(spacing: 8) {
                Text("Archived")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink2)
                Text("\(teammates.count)")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.ink3)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
                    .rotationEffect(.degrees(open ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityValue(open ? "Shown" : "Hidden")
        .accessibilityIdentifier("team-archived")
        if open {
            ForEach(teammates) { teammate in
                TeammateRowView(teammate: teammate, archived: true)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .contextMenu {
                        Button("Unarchive", systemImage: "arrow.uturn.backward") { Task { await model.archive(teammate, false) } }
                            .disabled(!model.isConnected)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Unarchive", systemImage: "arrow.uturn.backward") { Task { await model.archive(teammate, false) } }
                            .tint(Palette.accentFill)
                            .disabled(!model.isConnected)
                    }
                    .accessibilityIdentifier("archived-\(teammate.handle)")
            }
        }
    }
}

/// A teammate's row, pressed to open its chat; held, its chat or its Edit sheet.
struct TeammateLink: View {
    let teammate: Teammate
    @Environment(AppModel.self) private var model
    @State private var archiving = false

    var body: some View {
        Button {
            Task { await model.openTeammate(teammate) }
        } label: {
            TeammateRowView(teammate: teammate)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .contextMenu {
            Button("Open chat", systemImage: "bubble.left.and.text.bubble.right") {
                Task { await model.openTeammate(teammate) }
            }
            Button("Edit…", systemImage: "pencil") { model.teammateEditing = teammate.id }
                .disabled(!model.isConnected)
            Button(teammate.lead ? "Not the Lead" : "Make Lead", systemImage: teammate.lead ? "star.slash" : "star") {
                Task { await model.toggleLead(teammate) }
            }
            .disabled(!model.isConnected)
            Divider()
            Button("Archive", systemImage: "archivebox", role: .destructive) { archiving = true }
                .disabled(!model.isConnected)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Archive", systemImage: "archivebox") { archiving = true }
                .tint(Palette.accentFill)
                .disabled(!model.isConnected)
            Button("Edit", systemImage: "pencil") { model.teammateEditing = teammate.id }
                .tint(Palette.ink2)
                .disabled(!model.isConnected)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(teammate.lead ? "Not the Lead" : "Make Lead", systemImage: teammate.lead ? "star.slash" : "star") {
                Task { await model.toggleLead(teammate) }
            }
            .tint(Palette.accentFill)
            .disabled(!model.isConnected)
        }
        .sensoryFeedback(.selection, trigger: teammate.lead)
        // The Mac's own words for what Archive does.
        .confirmationDialog("Archive \(teammate.name)?", isPresented: $archiving, titleVisibility: .visible) {
            Button("Archive", role: .destructive) { Task { await model.archive(teammate) } }
                .accessibilityIdentifier("teammate-archive-confirm")
        } message: {
            Text("Leaves the Team list; its sessions stay.")
        }
        .accessibilityIdentifier("teammate-\(teammate.handle)")
    }
}

/// One teammate as its sidebar row says it, at a phone's size: its icon where a session's tile stands,
/// the Lead's with the star cut into it; its name; and a quiet line — its state where it is working or
/// waiting on the person, then what it is doing, else the one line of what it does.
struct TeammateRowView: View {
    let teammate: Teammate
    /// Put away: drawn quieter, with no state or time, and nothing to open.
    var archived = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 40

    var body: some View {
        let unread = !archived && teammate.unread == true
        HStack(alignment: .center, spacing: 12) {
            TeammateMark(icon: teammate.icon, size: side, lead: teammate.lead)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(teammate.name)
                        .font(.body.weight(unread ? .semibold : .medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    Text("@\(teammate.handle)")
                        .mono(.footnote)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                        .layoutPriority(-1)
                    Spacer(minLength: 0)
                    if !archived, teammate.state == nil || teammate.state == .idle, let at = teammate.activityAt {
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            Text(Ago.text(at, now: context.date))
                                .font(.footnote)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink3)
                        }
                        .fixedSize()
                    }
                }
                TeammateDoing(teammate: teammate, archived: archived)
            }
        }
        .padding(.vertical, 4)
        .opacity(archived ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(archived ? "\(teammate.name), archived" : TeammateWords.spoken(teammate))
        .accessibilityHint(archived ? "" : "Opens its chat")
    }
}

/// The row's quiet line: the state as its dot and its word, never colour alone, then what it is doing.
private struct TeammateDoing: View {
    let teammate: Teammate
    /// Put away: what it does, and nothing of what it was doing.
    var archived = false

    var body: some View {
        let doing = archived ? TeammateWords.role(teammate.brief) : teammate.activity ?? TeammateWords.role(teammate.brief)
        HStack(spacing: 6) {
            if !archived, let word = TeammateWords.state(teammate.state) {
                HStack(spacing: 5) {
                    StateDot(state: teammate.state)
                    Text(word)
                        .fontWeight(.semibold)
                        .foregroundStyle((teammate.state ?? .idle).tone.agentColor)
                }
                .fixedSize()
                if !doing.isEmpty { Text("·") }
            }
            if !doing.isEmpty {
                Text(doing)
                    .lineLimit(1)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink3)
        .accessibilityHidden(true)
    }
}

/// A teammate's state as the sidebar's dot: the quiet ink, breathing, while it works; amber while it
/// waits on the person; nothing while idle.
struct StateDot: View {
    let state: TeammateState?

    var body: some View {
        Circle()
            .fill((state ?? .idle).tone.agentColor)
            .frame(width: 7, height: 7)
            .restingPulse(when: state == .working)
            .opacity(state == nil || state == .idle ? 0 : 1)
            .accessibilityHidden(true)
    }
}

/// A teammate's chat is headed by the teammate, not by its session: its icon, its name, and how it
/// stands or the one line of what it does, where a session's title stands.
struct TeammateTitle: View {
    let teammate: Teammate
    let connected: Bool

    var body: some View {
        HStack(spacing: 8) {
            TeammateMark(icon: teammate.icon, size: 24, lead: teammate.lead)
            VStack(alignment: .leading, spacing: 1) {
                Text(teammate.name)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                Text(line)
                    .font(.caption)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .lineLimit(1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var line: String {
        if connected, let state = TeammateWords.state(teammate.state) { return state }
        let role = TeammateWords.role(teammate.brief)
        return role.isEmpty ? "@\(teammate.handle)" : role
    }
}

/// Who answers in a teammate's chat: the teammate, where a session's agent would be named.
struct TeammateSpeaker: View {
    let teammate: Teammate

    var body: some View {
        HStack(spacing: 8) {
            TeammateMark(icon: teammate.icon, size: 20, lead: teammate.lead)
            Text(teammate.name)
                .font(.headline)
                .foregroundStyle(Palette.ink)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A message an agent sent a teammate, as the sender's transcript shows it: the teammate it went to —
/// its icon, its name, its handle — what it was asked, and where that stands, pressed to open its chat.
/// The raw call and its "Sent to @x" are not drawn; the teammate's own chat is where its answer is.
struct TeammateCallLine: View {
    let call: TeammateCall
    let state: ToolState
    let newest: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        let teammate = call.id.flatMap { model.work.teammate($0) }
        let standing = TeammateCallState(call: state, teammate: teammate, newest: newest)
        let name = teammate?.name ?? "@\(call.handle)"
        Button {
            if let teammate { Task { await model.openTeammate(teammate) } }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                TeammateMark(icon: teammate?.icon, size: 28, lead: teammate?.lead ?? false)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                        if teammate != nil {
                            Text("@\(call.handle)")
                                .mono(.caption)
                                .foregroundStyle(Palette.ink3)
                        }
                        Spacer(minLength: 4)
                        CallStanding(standing: standing)
                    }
                    .lineLimit(1)
                    if !call.message.isEmpty {
                        Text(call.message)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Fill.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(CardButtonStyle())
        .disabled(teammate == nil)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(standing.word): \(call.message)")
        .accessibilityHint(teammate == nil ? "" : "Opens its chat")
        .accessibilityIdentifier("teammate-call-\(call.handle)")
    }
}

/// Where a call stands, as its mark and its word.
private struct CallStanding: View {
    let standing: TeammateCallState

    var body: some View {
        HStack(spacing: 4) {
            switch standing {
            case .working:
                ProgressView().controlSize(.mini)
            case .needsYou:
                Circle().fill(Palette.orange).frame(width: 7, height: 7)
            case .done:
                Image(systemName: "checkmark").font(.caption2.weight(.bold))
            }
            Text(standing.word)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(standing.tone.agentColor)
        .fixedSize()
    }
}

/// Another teammate's message in a chat: that teammate talking, so it stands on the agents' side under
/// its sender, as prose like any reply, never in the person's bubble.
struct TeammateSaid: View {
    let teammateId: String
    let text: String
    @Environment(AppModel.self) private var model

    var body: some View {
        let teammate = model.work.teammate(teammateId)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TeammateMark(icon: teammate?.icon, size: 20, lead: teammate?.lead ?? false)
                Text(teammate?.name ?? "A teammate")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
            }
            .accessibilityElement(children: .combine)
            MarkdownView(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Which teammates Home's Team lists: those of the spaces the profile shows, in the Mac's order.
enum TeamListing {
    static func teammates(_ all: [Teammate], in home: Home, choice: ProfileChoice) -> [Teammate] {
        let shown = Set(home.spaces.filter(choice.includes).map(\.id))
        return all.filter { shown.contains($0.spaceId) }
    }

    /// The spaces those teammates are in, which the section names when there is more than one.
    static func spaces(of teammates: [Teammate], in home: Home) -> [Space] {
        let ids = Set(teammates.map(\.spaceId))
        return home.spaces.filter { ids.contains($0.id) }
    }
}

extension TeammateState {
    var tone: Tone {
        switch self {
        case .idle: .quiet
        case .working: .working
        case .needsYou: .waiting
        }
    }
}

extension TeammateCallState {
    var tone: Tone {
        switch self {
        case .working: .working
        case .needsYou: .waiting
        case .done: .done
        }
    }
}

extension EnvironmentValues {
    /// The newest message to each teammate in the transcript being drawn, by row key: only that one
    /// says what its teammate is doing now.
    @Entry var newestTeammateCalls: Set<String> = []
}

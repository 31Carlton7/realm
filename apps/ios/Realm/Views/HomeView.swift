import RealmKit
import SwiftUI

/// The sidebar's answer to "what should I look at": what needs you, then each space's sessions by
/// activity. Under the title, the Mac and its state.
struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if let savedAt = model.store.homeSavedAt, model.store.home != nil {
                    LastUpdated(savedAt: savedAt)
                        .padding(.bottom, 4)
                }
                if case .refused(_, let reason) = model.store.connection {
                    RefusedNote(reason: reason)
                }
                if let home = model.store.home {
                    if !home.needsYou.isEmpty {
                        SectionHead(title: "Needs you", symbol: "hand.raised")
                        // A session that needs you is listed in its space too: each card has its
                        // section's identity, or the lazy stack draws one of the two as a hole.
                        ForEach(home.needsYou) { row in
                            SessionCard(row: row, showsSpace: true)
                                .id("needs-you/\(row.id)")
                        }
                    }
                    ForEach(home.spaces) { space in
                        SectionHead(title: space.name, emoji: space.emoji)
                        if space.sessions.isEmpty {
                            Text("No sessions yet")
                                .inter(.subheadline)
                                .foregroundStyle(Palette.ink2)
                                .padding(.horizontal, 4)
                        }
                        ForEach(space.sessions) { row in
                            SessionCard(row: row, showsSpace: false)
                                .id("\(space.id)/\(row.id)")
                        }
                        if space.more > 0 {
                            Text("\(space.more) more on your Mac")
                                .inter(.subheadline)
                                .foregroundStyle(Palette.ink2)
                                .padding(.horizontal, 4)
                                .padding(.top, 2)
                        }
                    }
                    if home.spaces.isEmpty && home.needsYou.isEmpty {
                        Text("There are no spaces on your Mac yet. Make one in Realm on your Mac.")
                            .inter(.body)
                            .foregroundStyle(Palette.ink2)
                    }
                } else {
                    FirstLoad()
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(Palette.page)
        .navigationTitle("Sessions")
        .navigationSubtitle(model.macLine)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.settings) {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .refreshable { await model.refresh() }
    }
}

/// A section's name at the caption rung, in sentence case, with its glyph.
struct SectionHead: View {
    let title: String
    var symbol: String?
    var emoji: String?

    var body: some View {
        HStack(spacing: 6) {
            if let emoji {
                Text(emoji).accessibilityHidden(true)
            } else if let symbol {
                Image(systemName: symbol)
                    .accessibilityHidden(true)
            }
            Text(title)
        }
        .inter(.footnote, .medium)
        .foregroundStyle(Palette.ink2)
        .padding(.top, 18)
        .padding(.bottom, 2)
        .padding(.horizontal, 4)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One session: its title, then the status as a word and a glyph, the agent and model, and how long
/// ago it moved. A row of more than one line is a card, with air round it rather than a rule.
struct SessionCard: View {
    let row: SessionRow
    let showsSpace: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At the accessibility sizes nothing shares a line with the title: each part gets the width.
        let stacked = dynamicTypeSize.isAccessibilitySize
        let titleLine = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        let detailLine = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))
        NavigationLink(value: Route.session(row.id)) {
            VStack(alignment: .leading, spacing: 6) {
                titleLine {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if row.unread {
                            Circle()
                                .fill(Palette.accent)
                                .frame(width: 7, height: 7)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                        }
                        Text(row.title.isEmpty ? "Untitled session" : row.title)
                            .inter(.body, .medium)
                            .foregroundStyle(Palette.ink)
                            .multilineTextAlignment(.leading)
                            .lineLimit(stacked ? 5 : 2)
                    }
                    .layoutPriority(1)
                    if !stacked { Spacer(minLength: 8) }
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(Ago.text(row.updatedAt, now: context.date))
                            .inter(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(Palette.ink3)
                    }
                    .fixedSize()
                }
                detailLine {
                    StatusLabel(status: row.status)
                        .fixedSize(horizontal: !stacked, vertical: false)
                    SessionDetail(row: row, showsSpace: showsSpace, leadingDot: !stacked)
                        .lineLimit(stacked ? 3 : 1)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(CardButtonStyle())
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Opens the session")
        .accessibilityIdentifier("session-\(row.id)")
    }

    private var accessibilityText: String {
        var parts = [row.title.isEmpty ? "Untitled session" : row.title, row.status.word]
        if row.unread { parts.append("Unread") }
        parts.append(contentsOf: [row.spaceName, AgentNames.label(row.agent)].filter { !$0.isEmpty })
        if let model = row.model { parts.append(model) }
        parts.append(Ago.text(row.updatedAt))
        return parts.joined(separator: ", ")
    }
}

/// A status as its word with its glyph, in its tone: never colour alone.
struct StatusLabel: View {
    let status: SessionStatus

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: status.symbol)
                .imageScale(.small)
            Text(status.word)
        }
        .inter(.subheadline, .medium)
        .foregroundStyle(status.tone.color)
        .accessibilityElement(children: .combine)
    }
}

/// After the status: the space (only where no section names it), the agent, and the model in mono.
/// It is one line, and it yields from its end, so the model goes first.
struct SessionDetail: View {
    let row: SessionRow
    let showsSpace: Bool
    /// The dot that joins it to the status before it, when the two share a line.
    var leadingDot = true
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.legibilityWeight) private var legibilityWeight

    var body: some View {
        Text(detail)
            .foregroundStyle(Palette.ink2)
            .truncationMode(.tail)
    }

    private var detail: AttributedString {
        let fonts = RealmFonts(dynamicTypeSize: dynamicTypeSize, boldText: legibilityWeight == .bold)
        var words = AttributedString((leadingDot ? "· " : "") + [showsSpace ? row.spaceName : nil, AgentNames.label(row.agent)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        words.font = fonts.inter(.subheadline)
        guard let model = row.model, !model.isEmpty else { return words }
        var separator = AttributedString(" · ")
        separator.font = fonts.inter(.subheadline)
        var name = AttributedString(model)
        name.font = fonts.mono(.footnote)
        return words + separator + name
    }
}

/// "Last updated 10:42": what is on screen came from the cache, or from before the connection went.
struct LastUpdated: View {
    let savedAt: Date

    var body: some View {
        Label {
            Text("Last updated \(LinkStatus.moment(savedAt, now: Date(), calendar: .current, locale: .current))")
        } icon: {
            Image(systemName: "clock.arrow.circlepath")
        }
        .inter(.footnote)
        .foregroundStyle(Palette.ink2)
        .accessibilityElement(children: .combine)
    }
}

struct RefusedNote: View {
    let reason: String
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(reason, systemImage: "xmark.octagon")
                .inter(.body, .medium)
                .foregroundStyle(Palette.ink)
            Text("To see its sessions again, make a pairing code in Settings ▸ Devices on your Mac and scan it here.")
                .inter(.subheadline)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button("Pair again") { model.pairingRequested = true }
                .buttonStyle(RealmButtonStyle(primary: true))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
    }
}

/// Before the Mac has sent anything: what the connection is doing, in words.
struct FirstLoad: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let status = model.linkStatus
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if status.kind == .connecting || status.kind == .connected {
                    ProgressView()
                } else {
                    Image(systemName: status.symbol)
                        .foregroundStyle(Palette.ink2)
                }
                Text(status.kind == .connected ? "Loading your sessions…" : status.words)
                    .inter(.body, .medium)
                    .foregroundStyle(Palette.ink)
            }
            if case .asleep = status.kind {
                Text("While your Mac sleeps, this iPhone cannot reach it. Its sessions show here once it wakes.")
                    .inter(.subheadline)
                    .foregroundStyle(Palette.ink2)
            } else if status.kind == .relayUnreachable {
                Text("Check this iPhone's connection. Realm keeps trying.")
                    .inter(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A card a person can open: a surface on the page that takes the press as a fill, one rung up,
/// arriving at once. A press is a fill, never a size.
struct CardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : Palette.surface,
                        in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }
}

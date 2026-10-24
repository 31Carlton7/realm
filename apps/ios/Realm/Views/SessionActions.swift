import RealmKit
import SwiftUI

/// A change the person makes to a session's row from the phone, as the Mac's sidebar makes it.
enum RowChange: Equatable {
    case title(String)
    case pinned(Bool)
    case archived(Bool)

    /// The field of the row it changes: a later change to the same field takes its place.
    enum Field: Hashable {
        case title, pinned, archived
    }

    var field: Field {
        switch self {
        case .title: .title
        case .pinned: .pinned
        case .archived: .archived
        }
    }

    /// What `session.update` is sent, one field of three.
    var title: String? {
        if case .title(let title) = self { return title }
        return nil
    }

    var pinned: Bool? {
        if case .pinned(let pinned) = self { return pinned }
        return nil
    }

    var archived: Bool? {
        if case .archived(let archived) = self { return archived }
        return nil
    }

    /// How a toast starts when the Mac refuses it; the Mac's reason follows.
    var refusal: String {
        switch self {
        case .title: "Not renamed."
        case .pinned(true): "Not pinned."
        case .pinned(false): "Not unpinned."
        case .archived(true): "Not archived."
        case .archived(false): "Not put back."
        }
    }
}

/// What the person changed about sessions' rows from this phone, shown over what the Mac last listed
/// from the moment it is made. A change the Mac refuses is taken back. One it takes stays over its
/// lists until a Home asked for after it lists the session, which says it from then on; a session the
/// Mac does not list again — archived, or older than Home's few — keeps it.
struct RowEdits: Equatable {
    private struct Edit: Equatable {
        let change: RowChange
        let token: Int
        /// How many Homes had been asked for when the Mac took it; nil while it is on its way.
        var takenAtAsk: Int?
    }

    private var edits: [String: [RowChange.Field: Edit]] = [:]
    private var made = 0

    /// Shows a change at once, over any earlier one to the same field. The token settles it.
    mutating func begin(_ change: RowChange, on id: String) -> Int {
        made += 1
        edits[id, default: [:]][change.field] = Edit(change: change, token: made)
        return made
    }

    /// The Mac took the change with `ask` Homes asked for so far: the next one it sends lists it so.
    mutating func taken(_ token: Int, on id: String, ask: Int) {
        guard let field = field(of: token, on: id) else { return }
        edits[id]?[field]?.takenAtAsk = ask
    }

    /// The Mac refused the change, or did not answer: the row is as the Mac lists it again, unless a
    /// later change to the same field has taken this one's place.
    mutating func refused(_ token: Int, on id: String) {
        guard let field = field(of: token, on: id) else { return }
        edits[id]?[field] = nil
        if edits[id]?.isEmpty == true { edits[id] = nil }
    }

    /// The Home the Mac sent for ask `ask`: what it took before that ask, it now says itself for every
    /// session the Home lists.
    mutating func caughtUp(with home: Home, ask: Int) {
        let listed = Set(home.listedRows.map(\.id))
        for (id, fields) in edits where listed.contains(id) {
            let left = fields.filter { _, edit in edit.takenAtAsk.map { $0 >= ask } ?? true }
            edits[id] = left.isEmpty ? nil : left
        }
    }

    /// A row as the person last changed it; nil once they archived it.
    func applied(to row: SessionRow) -> SessionRow? {
        guard let fields = edits[row.id] else { return row }
        var row = row
        for edit in fields.values {
            switch edit.change {
            case .title(let title): row.title = title
            case .pinned(let pinned): row.pinned = pinned
            case .archived(let archived): if archived { return nil }
            }
        }
        return row
    }

    func applied(to rows: [SessionRow]) -> [SessionRow] {
        rows.compactMap(applied)
    }

    /// Home with every row as the person last changed it, and what they archived gone from it.
    func applied(to home: Home) -> Home {
        guard !edits.isEmpty else { return home }
        let spaces = home.spaces.map { space in
            Space(id: space.id, name: space.name, icon: space.icon, color: space.color, sessions: applied(to: space.sessions),
                  more: space.more, iconKind: space.iconKind, glyph: space.glyph, emoji: space.emoji, profileId: space.profileId)
        }
        return Home(mac: home.mac, needsYou: applied(to: home.needsYou), spaces: spaces, profiles: home.profiles,
                    profileId: home.profileId, recent: home.recent.map(applied))
    }

    private func field(of token: Int, on id: String) -> RowChange.Field? {
        edits[id]?.first { $0.value.token == token }?.key
    }
}

extension Home {
    /// Every row Home holds — Needs you's, each space's newest few and the recent list's — a session as
    /// often as it is listed.
    var listedRows: [SessionRow] {
        needsYou + spaces.flatMap(\.sessions) + (recent ?? [])
    }
}

extension SessionRow {
    /// A Pinned row's identity, apart from the same session's row in its space.
    var pinnedKey: String { "pinned/\(id)" }
}

/// What can be done to a session from its row, or from its screen's menu.
enum RowAction: Hashable, Identifiable {
    case pin, unpin, rename, archive, stop

    var id: Self { self }

    var title: String {
        switch self {
        case .pin: "Pin"
        case .unpin: "Unpin"
        case .rename: "Rename"
        case .archive: "Archive"
        case .stop: "Stop"
        }
    }

    var symbol: String {
        switch self {
        case .pin: "pin"
        case .unpin: "pin.slash"
        case .rename: "pencil"
        case .archive: "archivebox"
        case .stop: "stop.fill"
        }
    }

    /// A swipe button's fill: the accent for the one each edge leads with, the composer's ink for Stop.
    var tint: Color {
        switch self {
        case .pin, .unpin, .archive: Palette.accentFill
        case .rename: Palette.ink2
        case .stop: Palette.ink
        }
    }
}

/// The actions a session's row offers in the state it is in, and where: Pin or Unpin from the leading
/// edge; Archive, Rename and, while a turn is under way, Stop from the trailing edge, outermost first;
/// all of them in a press-and-hold, Stop last. Pin, Rename and Archive change the Mac's own row, so they
/// are off while it is away; Stop keeps its place, and says why it cannot go.
struct RowActions: Equatable {
    let leading: [RowAction]
    let trailing: [RowAction]
    let menu: [RowAction]
    private let connected: Bool

    init(row: SessionRow, connected: Bool) {
        let pin: RowAction = row.pinned == true ? .unpin : .pin
        let stop: [RowAction] = row.isWorking ? [.stop] : []
        leading = [pin]
        trailing = [.archive, .rename] + stop
        menu = [pin, .rename, .archive] + stop
        self.connected = connected
    }

    func isOff(_ action: RowAction) -> Bool {
        action != .stop && !connected
    }
}

/// The Rename alert's state: the session, and what its field holds.
struct RenameDraft: Equatable {
    let row: SessionRow
    var title: String

    init(row: SessionRow) {
        self.row = row
        title = row.title
    }

    /// The title to send, trimmed to what the Mac keeps; nil while it is empty or still the old one.
    var change: String? {
        let words = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return words.isEmpty || words == row.title ? nil : words
    }
}

extension View {
    /// A session row's actions, from a swipe either way, a press-and-hold, and VoiceOver's actions.
    func sessionRowActions(_ row: SessionRow) -> some View {
        modifier(SessionRowActions(row: row))
    }
}

private struct SessionRowActions: ViewModifier {
    let row: SessionRow
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        let actions = RowActions(row: row, connected: model.isConnected)
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                ForEach(actions.leading) { action in
                    button(action, actions).tint(action.tint)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                ForEach(actions.trailing) { action in
                    button(action, actions).tint(action.tint)
                }
            }
            .contextMenu {
                ForEach(actions.menu) { action in
                    // A menu takes its glyphs' colour from the app's tint: Stop's takes its words' red.
                    if action == .stop { button(action, actions, role: .destructive).tint(.red) } else { button(action, actions) }
                }
            }
            .accessibilityActions {
                ForEach(actions.menu.filter { !actions.isOff($0) }) { action in
                    Button(action.title) { model.perform(action, on: row) }
                }
            }
    }

    /// A swipe button never takes the destructive role, which would draw the row as deleted.
    private func button(_ action: RowAction, _ actions: RowActions, role: ButtonRole? = nil) -> some View {
        Button(action.title, systemImage: action.symbol, role: role) { model.perform(action, on: row) }
            .disabled(actions.isOff(action))
    }
}

/// The session's own menu, at the end of its bar: Pin or Unpin, Rename and Archive, as its row offers
/// them; Stop is the composer's. Archived, the session leaves the screen, and the toast's Undo puts it
/// back on Home.
struct SessionMenu: View {
    let row: SessionRow
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let actions = RowActions(row: row, connected: model.isConnected)
        Menu {
            ForEach(actions.menu.filter { $0 != .stop }) { action in
                Button(action.title, systemImage: action.symbol) {
                    model.perform(action, on: row)
                    if action == .archive { dismiss() }
                }
                .disabled(actions.isOff(action))
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("session-menu")
    }
}

extension View {
    /// The alert Rename opens, wherever it was pressed: the title in a field, and Rename to keep it.
    func renameAlert() -> some View {
        modifier(RenameAlert())
    }
}

private struct RenameAlert: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.alert("Rename session", isPresented: shown) {
            TextField("Title", text: title)
            Button("Cancel", role: .cancel) { model.renaming = nil }
            Button("Rename") { model.rename() }
                .disabled(model.renaming?.change == nil)
        }
    }

    private var shown: Binding<Bool> {
        Binding(get: { model.renaming != nil }, set: { if !$0 { model.renaming = nil } })
    }

    private var title: Binding<String> {
        Binding(get: { model.renaming?.title ?? "" }, set: { model.renaming?.title = $0 })
    }
}

extension AppModel {
    func perform(_ action: RowAction, on row: SessionRow) {
        switch action {
        case .pin: change(.pinned(true), of: row)
        case .unpin: change(.pinned(false), of: row)
        case .rename: renaming = RenameDraft(row: row)
        case .archive: change(.archived(true), of: row)
        case .stop: Task { await stop(row.id) }
        }
    }

    /// Renames the session the alert is up for, if its field says something new.
    func rename() {
        guard let draft = renaming else { return }
        renaming = nil
        if let title = draft.change { change(.title(title), of: draft.row) }
    }

    /// A rename, a pin or an archive: shown at once, then sent, and put back with a toast where the Mac
    /// refuses it. A session's changes go to the Mac in the order they were made, so an Undo never
    /// overtakes the archive it takes back. An archive's toast carries that Undo.
    func change(_ change: RowChange, of row: SessionRow) {
        guard isConnected else {
            show(toast: "Connect to your Mac to change this session.")
            return
        }
        let token = rowEdits.begin(change, on: row.id)
        if change == .archived(true) {
            show(toast: "Archived “\(row.displayTitle)”.") { [weak self] in self?.change(.archived(false), of: row) }
        }
        let before = rowChanges[row.id]
        rowChanges[row.id] = Task { [weak self] in
            await before?.value
            await self?.send(change, token: token, of: row.id)
        }
    }

    private func send(_ change: RowChange, token: Int, of id: String) async {
        do {
            guard let api, isConnected else { throw ChannelError.notConnected }
            let row = try await api.updateSession(id: id, title: change.title, pinned: change.pinned, archived: change.archived)
            rowEdits.taken(token, on: id, ask: homeAsks)
            if let row { store.sessionChanged(row) }
            await refreshHome()
        } catch {
            rowEdits.refused(token, on: id)
            show(toast: "\(change.refusal) \(Self.describe(error))")
        }
    }
}

import RealmKit
import SwiftUI

/// A space's own page: every session it lists, the newest activity first, asked of the Mac a page
/// at a time as the end comes into view. Until the first page comes, the few Home already has.
struct SpaceView: View {
    let spaceId: String
    @Environment(AppModel.self) private var model
    @State private var pages = SpacePages()
    @State private var query = ""
    @State private var loading = false

    var body: some View {
        let home = model.store.home
        let space = home?.spaces.first { $0.id == spaceId }
        let rows = pages.loaded ? pages.rows : (space?.sessions ?? [])
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = rows.filter { $0.matches(words) }
        List {
            ForEach(shown) { row in
                SessionLink(row: row, space: nil)
            }
            if words.isEmpty {
                if model.isConnected, !pages.loaded || pages.more {
                    // The end of what is here is in view: the first page, or the next.
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .task(id: rows.count) { await load(next: pages.loaded) }
                } else if !model.isConnected, let rest = pages.rest(beyond: space) {
                    Text(rest)
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden, edges: .bottom)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .overlay {
            if !words.isEmpty, shown.isEmpty {
                ContentUnavailableView {
                    Label("No results for “\(words)”", systemImage: "magnifyingglass")
                } description: {
                    Text(pages.more ? "This searches the sessions shown so far. Clear the search and scroll down for older ones."
                                    : "This searches the sessions shown here.")
                }
            } else if pages.loaded, rows.isEmpty {
                ContentUnavailableView("No sessions here", systemImage: "text.bubble",
                                       description: Text("Start one in this space in Realm on your Mac, and it shows here."))
            }
        }
        .navigationTitle(space?.name ?? "Space")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let space {
                ToolbarItem(placement: .principal) {
                    SpaceTitle(space: space)
                }
            }
        }
        .searchable(text: $query, prompt: "Search \(space?.name ?? "this space")")
        .refreshable { await load(next: false) }
        .onChange(of: home) { _, home in
            // Home hears of every change the Mac makes: what it says of sessions here is newer.
            if let home { pages.refresh(with: home.rows(of: spaceId)) }
        }
    }

    /// The first page again, or the one after what is here.
    private func load(next: Bool) async {
        guard !loading, model.isConnected else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await model.spaceSessions(spaceId, from: next ? pages.offset : 0)
            if next { pages.append(page) } else { pages.start(page) }
        } catch is CancellationError {
        } catch {
            model.show(toast: AppModel.describe(error))
        }
    }
}

/// The page's title: the space's glyph in its colour, and its name.
private struct SpaceTitle: View {
    let space: Space

    var body: some View {
        HStack(spacing: 6) {
            SpaceGlyph(space: space, size: 18, relativeTo: .headline)
            Text(space.name)
                .font(.headline)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A space's sessions as its page holds them: pages of `space.sessions`, the newest activity first,
/// kept up to date by what Home hears.
struct SpacePages: Equatable {
    /// How many sessions a page asks for.
    static let size = 50

    private(set) var rows: [SessionRow] = []
    /// The Mac has more after these.
    private(set) var more = false
    /// The first page has come.
    private(set) var loaded = false

    /// Where the next page starts. A session that moved to the top since the last page moved every
    /// other down one, so the next page repeats one already here, which is left out; none is missed.
    var offset: Int { rows.count }

    /// While the Mac is away, what it holds beyond what is here: as many as Home counted before the
    /// first page came, and no count once pages have.
    func rest(beyond space: Space?) -> String? {
        if loaded { return more ? "The rest are on your Mac." : nil }
        guard let more = space?.more, more > 0 else { return nil }
        return "\(more) more on your Mac"
    }

    mutating func start(_ page: SpaceSessions) {
        rows = page.sessions
        more = page.more
        loaded = true
    }

    mutating func append(_ page: SpaceSessions) {
        let ids = Set(rows.map(\.id))
        rows += page.sessions.filter { !ids.contains($0.id) }
        more = page.more
    }

    /// Newer word of sessions in the space, from Home: each takes the place of the row it updates, a
    /// new one joins where its activity puts it, and the list is in order of activity again. One older
    /// than everything here belongs to a page not fetched yet, and comes with it.
    mutating func refresh(with fresh: [SessionRow]) {
        guard loaded else { return }
        let oldest = rows.last?.lastActivity ?? 0
        var updated = rows
        for row in fresh {
            if let index = updated.firstIndex(where: { $0.id == row.id }) {
                // `updatedAt` moves with every change to a session, read or set up anew: it says which
                // word is the newer, where its activity says only where it goes.
                if row.updatedAt >= updated[index].updatedAt { updated[index] = row }
            } else if !more || row.lastActivity >= oldest {
                updated.append(row)
            }
        }
        rows = updated.stablySorted { $0.lastActivity > $1.lastActivity }
    }
}

extension Home {
    /// Every row Home holds of a space's sessions — its newest few, Needs you's and the recent list's —
    /// each session once.
    func rows(of spaceId: String) -> [SessionRow] {
        let all = (spaces.first { $0.id == spaceId }?.sessions ?? []) + needsYou + (recent ?? [])
        var seen = Set<String>()
        return all.filter { $0.spaceId == spaceId && seen.insert($0.id).inserted }
    }
}

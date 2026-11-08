import RealmKit
import SwiftUI

/// One of the kinds the desktop's Library ▸ Files tells apart, in its words.
enum LibraryShelf: String, CaseIterable, Hashable {
    case made = "output"
    case attached = "upload"
    case added

    var title: String {
        switch self {
        case .made: "Made by agents"
        case .attached: "Attached by you"
        case .added: "Added by you"
        }
    }

    var symbol: String {
        switch self {
        case .made: "sparkles"
        case .attached: "paperclip"
        case .added: "plus.circle"
        }
    }
}

extension LibraryFile {
    /// Where the file came from, as the desktop's file rows say it.
    var cameFrom: String {
        switch origin {
        case "added": "Added by you"
        case "upload": "Attached to \(sessionTitle ?? "a session")"
        default: "Made in \(sessionTitle ?? "a session")"
        }
    }
}

/// The Library's files as a page holds them, the newest touched first.
struct LibraryPages: Equatable {
    private(set) var files: [LibraryFile] = []
    private(set) var next: LibraryCursor?
    private(set) var loaded = false

    mutating func start(_ page: LibraryPage) {
        files = page.entries
        next = page.next
        loaded = true
    }

    /// A file touched since the last page moved to the head, and is not listed again further down.
    mutating func append(_ page: LibraryPage) {
        let paths = Set(files.map(\.path))
        files += page.entries.filter { !paths.contains($0.path) }
        next = page.next
    }
}

/// What the Library's page shows of each shelf, and whether there is more to open.
struct ShelfHead: Equatable {
    static let shown = 5

    let files: [LibraryFile]
    let more: Bool

    /// One more than is shown is asked for, which is what says there is more.
    init(_ page: LibraryPage) {
        files = Array(page.entries.prefix(Self.shown))
        more = page.entries.count > Self.shown || page.next != nil && page.entries.count >= Self.shown
    }
}

/// The desktop's Library on the phone, read-only: the turns saved and the files of the profile Home
/// shows, the newest of each on one page, each opening as it would anywhere else in the app.
struct LibraryView: View {
    @Environment(AppModel.self) private var model
    @State private var saved: SavedTurns?
    @State private var shelves: [LibraryShelf: ShelfHead] = [:]
    @State private var problem: String?
    @State private var query = ""
    @State private var searched: SearchAnswer<[LibraryFile]>?
    @State private var gallery: GalleryShown?

    private static let savedShown = 3

    var body: some View {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let found = searched?.answer(to: words)
        List {
            if words.isEmpty {
                if let saved, !saved.entries.isEmpty {
                    Section {
                        ForEach(saved.entries.prefix(Self.savedShown)) { turn in
                            Button {
                                model.path.append(.session(turn.sessionId))
                            } label: {
                                SavedLine(turn: turn, leadsSection: turn.id == saved.entries.first?.id)
                            }
                            .fileRow()
                            .accessibilityHint("Opens \(turn.sessionTitle) at this prompt")
                        }
                    } header: {
                        Button { model.path.append(.saved) } label: {
                            SectionHead(title: "Saved", opens: true) {
                                Image(systemName: "bookmark").foregroundStyle(Palette.ink2)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets())
                        .accessibilityIdentifier("library-saved")
                    }
                }
                ForEach(LibraryShelf.allCases, id: \.self) { shelf in
                    if let head = shelves[shelf], !head.files.isEmpty {
                        shelfSection(shelf, head: head)
                    }
                }
            } else if let found {
                ForEach(found) { file in
                    Button {
                        openFile(file, among: found, from: .library, model: model, gallery: &gallery)
                    } label: {
                        FileLine(symbol: file.symbol, name: file.name, about: file.cameFrom, detail: Ago.text(file.at, now: .now))
                    }
                    .fileRow()
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(HomeView.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let problem, saved == nil, shelves.isEmpty {
                ContentUnavailableView("Library", systemImage: "books.vertical", description: Text(problem))
            } else if !words.isEmpty {
                if let found, found.isEmpty {
                    NoResults(query: words, why: "This searches the names of the Library's files.")
                }
            } else if saved == nil || shelves.isEmpty {
                Unreached(what: "The Library", working: model.isConnected)
            } else if saved?.entries.isEmpty == true, shelves.values.allSatisfy(\.files.isEmpty) {
                ContentUnavailableView("Nothing here yet", systemImage: "books.vertical",
                                       description: Text("Turns you save, and files your sessions make or are sent, are kept here."))
            }
        }
        .navigationTitle("Library")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaBar(edge: .bottom) {
            SearchBar(prompt: "Search files", query: $query) { query = "" }
        }
        .fullScreenCover(item: $gallery) { shown in
            AttachmentGallery(pages: shown.pages, source: shown.source, page: shown.page)
        }
        .task(id: model.channelGeneration) { await load() }
        .task(id: words) { await search(words) }
        .refreshable { await load() }
    }

    private func shelfSection(_ shelf: LibraryShelf, head: ShelfHead) -> some View {
        Section {
            ForEach(head.files) { file in
                Button {
                    openFile(file, among: head.files, from: .library, model: model, gallery: &gallery)
                } label: {
                    FileLine(symbol: file.symbol, name: file.name, about: file.sessionTitle, detail: Ago.text(file.at, now: .now),
                             leadsSection: file.id == head.files.first?.id)
                }
                .fileRow()
                .accessibilityIdentifier("library-file-\(file.name)")
            }
        } header: {
            if head.more {
                Button { model.path.append(.libraryFiles(shelf)) } label: {
                    SectionHead(title: shelf.title, opens: true) {
                        Image(systemName: shelf.symbol).foregroundStyle(Palette.ink2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
            } else {
                SectionHead(title: shelf.title) {
                    Image(systemName: shelf.symbol).foregroundStyle(Palette.ink2)
                }
            }
        }
    }

    private func load() async {
        guard let api = model.api, model.isConnected else { return }
        do {
            let profileId = model.profileChoice.profileId
            var heads: [LibraryShelf: ShelfHead] = [:]
            for shelf in LibraryShelf.allCases {
                let page = try await api.libraryFiles(profileId: profileId, origin: shelf.rawValue, limit: ShelfHead.shown + 1)
                heads[shelf] = ShelfHead(page)
            }
            shelves = heads
            if let turns = await model.savedInChoice() { saved = turns }
            problem = nil
        } catch is CancellationError {
        } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
            problem = "Update Realm on your Mac to open the Library here."
        } catch {
            problem = AppModel.describe(error)
        }
    }

    private func search(_ words: String) async {
        guard !words.isEmpty, let api = model.api, model.isConnected else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            let page = try await api.libraryFiles(profileId: model.profileChoice.profileId, query: words)
            searched = SearchAnswer(words: words, answer: page.entries)
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { model.show(toast: AppModel.describe(error)) }
        }
    }
}

/// A saved turn as a line of the Library: the prompt, and whose session it was.
private struct SavedLine: View {
    let turn: SavedTurn
    var leadsSection = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(turn.text.isEmpty ? turn.attachments.joined(separator: ", ") : turn.text)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(turn.sessionTitle) · \(turn.spaceName)")
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
                .lineLimit(1)
        }
        .padding(.vertical, 3)
        .padding(.top, leadsSection ? FileLine.fadeRoom : 0)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Every file on one of the Library's shelves, a page at a time as the end comes into view.
struct LibraryShelfView: View {
    let shelf: LibraryShelf
    @Environment(AppModel.self) private var model
    @State private var pages = LibraryPages()
    @State private var problem: String?
    @State private var loading = false
    @State private var gallery: GalleryShown?

    var body: some View {
        List {
            ForEach(pages.files) { file in
                Button {
                    openFile(file, among: pages.files, from: .library, model: model, gallery: &gallery)
                } label: {
                    FileLine(symbol: file.symbol, name: file.name, about: file.sessionTitle, detail: Ago.text(file.at, now: .now))
                }
                .fileRow()
            }
            if pages.next != nil {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .task(id: pages.files.count) { await load(next: true) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let problem, !pages.loaded {
                ContentUnavailableView(shelf.title, systemImage: shelf.symbol, description: Text(problem))
            } else if !pages.loaded {
                Unreached(what: shelf.title, working: model.isConnected)
            }
        }
        .navigationTitle(shelf.title)
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $gallery) { shown in
            AttachmentGallery(pages: shown.pages, source: shown.source, page: shown.page)
        }
        .task(id: model.channelGeneration) { await load(next: false) }
        .refreshable { await load(next: false) }
    }

    private func load(next: Bool) async {
        guard !loading, let api = model.api, model.isConnected else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await api.libraryFiles(profileId: model.profileChoice.profileId, origin: shelf.rawValue, before: next ? pages.next : nil)
            if next { pages.append(page) } else { pages.start(page) }
            problem = nil
        } catch is CancellationError {
        } catch {
            problem = AppModel.describe(error)
        }
    }
}

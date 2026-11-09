import RealmKit
import SwiftUI

/// A place of the memory library, as a route names it.
struct MemoryPlaceRef: Hashable {
    let id: String
    let profileId: String
    let title: String
    let kind: MemoryPlace.Kind
}

/// A memory, as a route names it.
struct MemoryRef: Hashable {
    let id: String
    let profileId: String
    let title: String
}

/// What Memory's page shows of each profile the choice takes in.
struct ProfileMemory: Equatable {
    let profileId: String
    let overview: MemoryOverview
}

/// The library's places in the order the page lists them: for each profile, what is for every space and
/// then its spaces in Home's order; last the agents' own files, which every profile shares and so are
/// listed once. With more than one profile shown, "Every space" says whose.
enum MemorySections {
    static func arranged(_ memories: [ProfileMemory], spaceOrder: [String], profileNames: [String: String]) -> [MemoryPlace] {
        func rank(_ place: MemoryPlace) -> Int { place.spaceId.flatMap(spaceOrder.firstIndex(of:)) ?? spaceOrder.count }
        var ownPlaces: [MemoryPlace] = []
        var agents: [MemoryPlace] = []
        var seen = Set<String>()
        for memory in memories {
            let every = memory.overview.places.filter { $0.kind == .every }.map { place -> MemoryPlace in
                guard memories.count > 1, let name = profileNames[memory.profileId] else { return place }
                return MemoryPlace(id: place.id, profileId: place.profileId, kind: place.kind, spaceId: nil, title: "\(name) · every space", count: place.count, entries: place.entries)
            }
            let spaces = memory.overview.places.filter { $0.kind == .space }.sorted { rank($0) < rank($1) }
            ownPlaces += every + spaces
            for agent in memory.overview.places where agent.kind == .agent && seen.insert(agent.id).inserted {
                agents.append(agent)
            }
        }
        return ownPlaces + agents
    }
}

/// A place's memories as its page holds them, the newest first.
struct MemoryPages: Equatable {
    private(set) var rows: [MemoryRow] = []
    private(set) var next: Int?
    private(set) var loaded = false

    mutating func start(_ page: MemoryPage) {
        rows = page.entries
        next = page.next
        loaded = true
    }

    /// A memory saved since the last page moved to the head, and is not listed again further down.
    mutating func append(_ page: MemoryPage) {
        let ids = Set(rows.map(\.id))
        rows += page.entries.filter { !ids.contains($0.id) }
        next = page.next
    }
}

/// A memory a search found, and the profile to open it in.
struct MemoryHit: Equatable, Identifiable {
    let row: MemoryRow
    let profileId: String

    var id: String { row.id }

    /// Each profile's answers in turn, best first, a file every profile shares only once.
    static func merged(_ answers: [(profileId: String, page: MemoryPage)]) -> [MemoryHit] {
        var seen = Set<String>()
        return answers.flatMap { answer in
            answer.page.entries.filter { seen.insert($0.id).inserted }.map { MemoryHit(row: $0, profileId: answer.profileId) }
        }
    }
}

/// The desktop's words for a memory's lines.
enum MemoryWords {
    /// The types a memory is filed under, as the desktop names them.
    static let types: [(id: String, label: String)] = [("user", "About you"), ("feedback", "Feedback"), ("project", "Project"), ("reference", "Reference")]

    static func typeLabel(_ type: String) -> String {
        types.first { $0.id == type }?.label ?? type
    }

    /// The line under a memory's title: a search's best line where it says something the title and the
    /// description do not.
    static func line(_ row: MemoryRow) -> String? {
        if let match = row.match, match != row.description, match != row.title { return match }
        return row.description
    }

    /// Where a memory sits, without what the head over it says: the place's name, in the source or as the
    /// folder, and the profile's repo, which goes without saying under a head. A search has no head, and
    /// says all of it.
    static func place(_ row: MemoryRow, under head: String? = nil) -> String {
        place(source: row.source, folder: row.folder, index: row.index, under: head)
    }

    static func place(source: String, folder: String?, index: Bool, under head: String? = nil) -> String {
        var parts = source.components(separatedBy: " · ")
        if let head {
            parts.removeAll { $0 == head || $0 == "Memory repo" }
        }
        if let folder, !index, folder != head { parts.append(folder) }
        return parts.joined(separator: " · ")
    }

    static func deleteMessage(external: Bool) -> String {
        external
            ? "It moves to the Trash, and the agent that reads it stops seeing it."
            : "It is removed from the memory repo with a commit, and its line leaves MEMORY.md."
    }

    static func deleted(_ name: String, trashed: Bool) -> String {
        trashed ? "\(name) is in the Trash." : "Removed \(name) from the memory repo."
    }

    /// Whose file a source outside Realm is: "Claude" of "Claude · User memory".
    static func owner(_ source: String) -> String? {
        source.components(separatedBy: " · ").first.flatMap { $0 == source || $0.isEmpty ? nil : $0 }
    }

    static func outsideQuestion(name: String, source: String) -> String {
        "\(name) is \(owner(source).map { "\($0)'s" } ?? "an agent's") own file, outside Realm. Write your change into it?"
    }

    /// The properties the reader lists: not those its head already says.
    static func properties(_ frontmatter: [MemoryFile.Field]) -> [MemoryFile.Field] {
        let shownElsewhere: Set<String> = ["name", "description", "type", "metadata.type"]
        return frontmatter.filter { !shownElsewhere.contains($0.key) }.map {
            MemoryFile.Field(key: $0.key.hasPrefix("metadata.") ? String($0.key.dropFirst("metadata.".count)) : $0.key, value: $0.value)
        }
    }

    /// The body without its opening `# Title` line when that is the title the head already shows.
    static func withoutTitle(_ body: String, title: String) -> String {
        var lines = body.split(separator: "\n", omittingEmptySubsequences: false)
        guard let first = lines.firstIndex(where: { !$0.allSatisfy(\.isWhitespace) }) else { return body }
        let heading = lines[first].drop { $0 == "#" }
        let marks = lines[first].count - heading.count
        guard (1...6).contains(marks), heading.first?.isWhitespace == true, heading.trimmingCharacters(in: .whitespaces) == title else { return body }
        lines.removeSubrange(...first)
        return lines.drop { $0.allSatisfy(\.isWhitespace) }.joined(separator: "\n")
    }
}

/// How a link between memories is carried through the Markdown renderer, which follows only web links:
/// an address no site answers, which the reader catches before anything could open it.
enum MemoryLinks {
    private static let host = "memory.realm.invalid"

    private static func address(_ target: String) -> String {
        var parts = URLComponents()
        parts.scheme = "https"
        parts.host = host
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "target", value: target)]
        return parts.string ?? ""
    }

    static func target(of url: URL) -> String? {
        guard url.host == host else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
    }

    /// `body` with each `[[link]]` and each relative link the Mac recognised as one of these. A fenced
    /// block is left as it is.
    static func linked(_ body: String, links: [MemoryFile.Link]) -> String {
        var fenced = false
        return body.components(separatedBy: "\n").map { line in
            let opening = line.trimmingCharacters(in: .whitespaces)
            if opening.hasPrefix("```") || opening.hasPrefix("~~~") {
                fenced.toggle()
                return line
            }
            guard !fenced else { return line }
            var drawn = line
            for link in links {
                drawn = drawn.replacingOccurrences(of: "[[\(link.target)]]", with: "[\(link.target)](\(address(link.target)))")
                drawn = drawn.replacingOccurrences(of: "](\(link.target))", with: "](\(address(link.target)))")
            }
            return drawn
        }.joined(separator: "\n")
    }
}

/// A memory as a line of a list: what it is called, what it is about, where it is kept and how long ago
/// it changed.
struct MemoryLine: View {
    let row: MemoryRow
    var under: String?
    var leadsSection = false

    var body: some View {
        let place = MemoryWords.place(row, under: under)
        VStack(alignment: .leading, spacing: 3) {
            Text(row.title)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(MemoryWords.line(row) ?? "Empty")
                .font(.subheadline)
                .foregroundStyle(MemoryWords.line(row) == nil ? Palette.ink3 : Palette.ink2)
                .lineLimit(2)
            Text(place.isEmpty ? Ago.text(row.updatedAt, now: .now) : "\(place) · \(Ago.text(row.updatedAt, now: .now))")
                .font(.footnote)
                .foregroundStyle(Palette.ink3)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.vertical, 2)
        .padding(.top, leadsSection ? FileLine.fadeRoom : 0)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// What agents on the Mac have learned, as the desktop's Library ▸ Memory has it, grouped by who it is
/// for: every space, each space, and each agent's own files. Each place shows its newest few and opens to
/// the rest. A search reads every memory's name, description and text.
struct MemoryView: View {
    @Environment(AppModel.self) private var model
    @State private var memories: [ProfileMemory]?
    @State private var learning: [String: Bool] = [:]
    @State private var problem: String?
    @State private var query = ""
    @State private var searched: SearchAnswer<[MemoryHit]>?
    @State private var writing = false

    private var profileIds: [String] {
        model.profileChoice.profileId.map { [$0] } ?? (model.store.home?.profiles?.map(\.id) ?? [])
    }

    private var names: [String: String] {
        Dictionary((model.store.home?.profiles ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let found = searched?.answer(to: words)
        let places = MemorySections.arranged(memories ?? [], spaceOrder: (model.store.home?.spaces ?? []).map(\.id), profileNames: names)
        List {
            if words.isEmpty {
                ForEach(places) { place in
                    placeSection(place)
                }
                if let memories {
                    learningSection(memories)
                }
            } else if let found {
                ForEach(found) { hit in
                    Button {
                        model.path.append(.memoryFile(MemoryRef(id: hit.row.id, profileId: hit.profileId, title: hit.row.title)))
                    } label: {
                        MemoryLine(row: hit.row)
                    }
                    .fileRow()
                    .accessibilityIdentifier("memory-hit-\(hit.row.title)")
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(HomeView.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let problem, memories == nil {
                ContentUnavailableView("Memory", systemImage: WorkPage.memory.symbol, description: Text(problem))
            } else if !words.isEmpty {
                if let found, found.isEmpty {
                    NoResults(query: words, why: "Search reads every memory's name, description and text. Try fewer words.")
                }
            } else if memories == nil {
                Unreached(what: "Memory", working: model.isConnected)
            } else if places.isEmpty {
                ContentUnavailableView("No memory here yet", systemImage: WorkPage.memory.symbol,
                                       description: Text("Agents save what they learn here as they work, or write one yourself."))
            }
        }
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if memories != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New memory", systemImage: "plus") { writing = true }
                        .accessibilityIdentifier("memory-new")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .safeAreaBar(edge: .bottom) {
            SearchBar(prompt: "Search memory", query: $query) { query = "" }
        }
        .sheet(isPresented: $writing) {
            NewMemorySheet(memories: memories ?? []) { made, profileId in
                model.memoryChanges += 1
                model.path.append(.memoryFile(MemoryRef(id: made.id, profileId: profileId, title: made.title)))
            }
        }
        .task(id: [model.channelGeneration, model.memoryChanges]) { await load() }
        .task(id: words) { await search(words) }
        .refreshable { await load() }
    }

    private func placeSection(_ place: MemoryPlace) -> some View {
        Section {
            ForEach(place.entries) { row in
                Button {
                    model.path.append(.memoryFile(MemoryRef(id: row.id, profileId: place.profileId, title: row.title)))
                } label: {
                    MemoryLine(row: row, under: place.title, leadsSection: row.id == place.entries.first?.id)
                }
                .fileRow()
                .accessibilityIdentifier("memory-\(row.title)")
            }
        } header: {
            if place.count > place.entries.count {
                Button {
                    model.path.append(.memoryPlace(MemoryPlaceRef(id: place.id, profileId: place.profileId, title: place.title, kind: place.kind)))
                } label: {
                    SectionHead(title: place.title, opens: true) { glyph(place) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets())
                .accessibilityIdentifier("memory-place-\(place.title)")
            } else {
                SectionHead(title: place.title) { glyph(place) }
            }
        }
    }

    @ViewBuilder
    private func glyph(_ place: MemoryPlace) -> some View {
        if let space = model.store.home?.spaces.first(where: { $0.id == place.spaceId }) {
            SpaceGlyph(space: space)
        } else {
            Image(systemName: place.kind == .every ? "square.stack" : "person.crop.circle").foregroundStyle(Palette.ink2)
        }
    }

    /// The desktop's Learn from sessions, for each profile shown.
    private func learningSection(_ memories: [ProfileMemory]) -> some View {
        Section {
            ForEach(memories, id: \.profileId) { memory in
                Toggle(isOn: Binding(get: { learning[memory.profileId] ?? memory.overview.learning }, set: { on in setLearning(on, profileId: memory.profileId) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(memories.count > 1 ? "Learn from sessions · \(names[memory.profileId] ?? "")" : "Learn from sessions")
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                        Text("After a session goes quiet, Realm saves what it learned and keeps this memory tidy, using the same frontier model as your sessions, on your account.")
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                .tint(Palette.accent)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityIdentifier("memory-learning")
            }
        }
    }

    private func setLearning(_ on: Bool, profileId: String) {
        let before = learning[profileId]
        learning[profileId] = on
        Task {
            do {
                guard let api = model.api, model.isConnected else { throw ChannelError.notConnected }
                learning[profileId] = try await api.setMemoryLearning(profileId: profileId, on: on)
            } catch {
                learning[profileId] = before
                model.show(toast: AppModel.describe(error))
            }
        }
    }

    private func load() async {
        guard let api = model.api, model.isConnected else { return }
        do {
            var loaded: [ProfileMemory] = []
            for profileId in profileIds {
                loaded.append(ProfileMemory(profileId: profileId, overview: try await api.memoryOverview(profileId: profileId)))
            }
            memories = loaded
            learning = [:]
            problem = nil
        } catch is CancellationError {
        } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
            problem = "Update Realm on your Mac to open Memory here."
        } catch {
            problem = AppModel.describe(error)
        }
    }

    /// Rested a moment first, so a word typed is one question to the Mac.
    private func search(_ words: String) async {
        guard !words.isEmpty, let api = model.api, model.isConnected else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            var answers: [(profileId: String, page: MemoryPage)] = []
            for profileId in profileIds {
                answers.append((profileId, try await api.memoryPage(profileId: profileId, query: words)))
            }
            searched = SearchAnswer(words: words, answer: MemoryHit.merged(answers))
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { model.show(toast: AppModel.describe(error)) }
        }
    }
}

/// Every memory of one place, a page at a time as the end comes into view.
struct MemoryPlaceView: View {
    let place: MemoryPlaceRef
    @Environment(AppModel.self) private var model
    @State private var pages = MemoryPages()
    @State private var problem: String?
    @State private var loading = false

    var body: some View {
        List {
            ForEach(pages.rows) { row in
                Button {
                    model.path.append(.memoryFile(MemoryRef(id: row.id, profileId: place.profileId, title: row.title)))
                } label: {
                    MemoryLine(row: row, under: place.title)
                }
                .fileRow()
            }
            if pages.next != nil {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .task(id: pages.rows.count) { await load(next: true) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if let problem, !pages.loaded {
                ContentUnavailableView(place.title, systemImage: WorkPage.memory.symbol, description: Text(problem))
            } else if !pages.loaded {
                Unreached(what: place.title, working: model.isConnected)
            } else if pages.rows.isEmpty {
                ContentUnavailableView("Nothing is kept here yet", systemImage: WorkPage.memory.symbol)
            }
        }
        .navigationTitle(place.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: [model.channelGeneration, model.memoryChanges]) { await load(next: false) }
        .refreshable { await load(next: false) }
    }

    private func load(next: Bool) async {
        guard !loading, let api = model.api, model.isConnected else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await api.memoryPage(profileId: place.profileId, place: place.id, offset: next ? pages.next ?? 0 : 0)
            if next { pages.append(page) } else { pages.start(page) }
            problem = nil
        } catch is CancellationError {
        } catch {
            problem = AppModel.describe(error)
        }
    }
}

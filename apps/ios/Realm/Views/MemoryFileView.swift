import RealmKit
import RealmMarkdown
import SwiftUI

/// A memory open to read: rendered as the phone renders Markdown, with its frontmatter as a quiet list of
/// properties and who reads it. Edit and Delete are the desktop's, with its words. A file the Mac will not
/// send says why in the Mac's words.
struct MemoryFileView: View {
    let memory: MemoryRef
    @Environment(AppModel.self) private var model
    @State private var file: MemoryFile?
    @State private var blocks: [MarkdownBlock] = []
    @State private var problem: String?
    @State private var refused = false
    @State private var editing = false
    @State private var confirmingDelete = false

    private var name: String { (file?.displayPath ?? memory.title).components(separatedBy: "/").last ?? memory.title }

    var body: some View {
        Group {
            if let problem {
                ContentUnavailableView(memory.title, systemImage: refused ? "lock" : WorkPage.memory.symbol, description: Text(problem))
            } else if let file {
                reading(file)
            } else {
                Unreached(what: "This memory", working: model.isConnected)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let file, problem == nil {
                if file.deletable {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Delete…", systemImage: "trash") { confirmingDelete.toggle() }
                            .accessibilityIdentifier("memory-delete")
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
                if file.writable {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Edit", systemImage: "pencil") { editing = true }
                            .accessibilityIdentifier("memory-edit")
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let file {
                MemoryEditor(file: file, profileId: memory.profileId) { saved in
                    model.memoryChanges += 1
                    Task { await show(saved) }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if confirmingDelete, let file {
                MemoryConfirm(question: "Delete \(name)? \(MemoryWords.deleteMessage(external: file.external))",
                              stay: "Cancel", go: file.external ? "Move to Trash" : "Delete", destructive: true) {
                    confirmingDelete = false
                } onGo: {
                    confirmingDelete = false
                    Task { await delete() }
                }
            }
        }
        .task(id: model.channelGeneration) { await load() }
    }

    private func reading(_ file: MemoryFile) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                head(file)
                properties(file)
                if let note = file.note {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
                if blocks.isEmpty {
                    Text("Nothing written below the properties.")
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink3)
                } else {
                    MarkdownView(blocks: blocks, lazily: true)
                        .environment(\.openURL, OpenURLAction { url in follow(url, in: file) })
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private func head(_ file: MemoryFile) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(file.title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            Text("\(MemoryWords.place(source: file.source, folder: file.folder, index: file.index)) · Edited \(Ago.text(file.updatedAt, now: .now))")
                .font(.footnote)
                .foregroundStyle(Palette.ink3)
            if let lede = file.frontmatter.first(where: { $0.key == "description" })?.value {
                Text(lede)
                    .font(.body)
                    .foregroundStyle(Palette.ink2)
                    .padding(.top, 4)
            }
        }
    }

    private func properties(_ file: MemoryFile) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let type = file.type { property("Type", MemoryWords.typeLabel(type)) }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                propertyName("Read by")
                VStack(alignment: .leading, spacing: 4) {
                    if file.readBy.isEmpty {
                        propertyValue("No agent in Realm reads it.")
                    }
                    ForEach(file.readBy, id: \.self) { reader in
                        propertyValue(Self.reader(reader))
                    }
                }
            }
            ForEach(MemoryWords.properties(file.frontmatter), id: \.key) { field in
                property(field.key, field.value)
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                propertyName("File")
                Text(file.displayPath)
                    .mono(.caption)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }

    private static func reader(_ reader: MemoryFile.Reader) -> String {
        "\(reader.who) \(reader.where)\(reader.how.map { ", \($0)" } ?? "")"
    }

    private func property(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            propertyName(label)
            propertyValue(value)
        }
    }

    private func propertyValue(_ value: String) -> some View {
        Text(value)
            .font(.subheadline)
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func propertyName(_ label: String) -> some View {
        Text(label)
            .font(.subheadline)
            .foregroundStyle(Palette.ink3)
            .frame(width: 68, alignment: .leading)
    }

    /// A link to another memory opens it here, and one that leads nowhere the library knows says so; a web
    /// link goes as a link anywhere does.
    private func follow(_ url: URL, in file: MemoryFile) -> OpenURLAction.Result {
        guard let target = MemoryLinks.target(of: url) else { return .systemAction }
        if let id = file.links.first(where: { $0.target == target })?.id {
            model.path.append(.memoryFile(MemoryRef(id: id, profileId: memory.profileId, title: target)))
        } else {
            model.show(toast: "\(target) is not a memory file Realm can find.")
        }
        return .handled
    }

    private func load() async {
        guard let api = model.api, model.isConnected else { return }
        do {
            await show(try await api.memoryFile(id: memory.id, profileId: memory.profileId))
            problem = nil
        } catch is CancellationError {
        } catch ChannelError.rpc(let refusal) where refusal.code == "NOT_FOUND" {
            problem = "This memory is no longer on your Mac."
        } catch ChannelError.rpc(let refusal) {
            refused = refusal.code == "FORBIDDEN"
            problem = refusal.message
        } catch {
            problem = AppModel.describe(error)
        }
    }

    /// Words made ready away from the main thread: a long file takes a moment to parse.
    private func show(_ shown: MemoryFile) async {
        let source = MemoryLinks.linked(MemoryWords.withoutTitle(shown.body, title: shown.title), links: shown.links)
        blocks = await Task.detached(priority: .userInitiated) {
            source.allSatisfy(\.isWhitespace) ? [] : MarkdownBlocks.parse(source)
        }.value
        file = shown
    }

    private func delete() async {
        guard let api = model.api, model.isConnected, let file else {
            model.show(toast: AppModel.describe(ChannelError.notConnected))
            return
        }
        do {
            let trashed = try await api.deleteMemory(id: file.id, confirmExternal: file.external)
            model.show(toast: MemoryWords.deleted(name, trashed: trashed))
            model.memoryChanges += 1
            if model.path.last == .memoryFile(memory) { model.path.removeLast() }
        } catch {
            model.show(toast: AppModel.describe(error))
        }
    }
}

/// The desktop's band that asks before a memory is deleted or a file outside Realm is written: on the
/// ground of the page it asks about, its question and its two answers.
private struct MemoryConfirm: View {
    let question: String
    let stay: String
    let go: String
    var destructive = false
    let onStay: () -> Void
    let onGo: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(question)
                .font(.subheadline)
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button(stay, action: onStay)
                    .buttonStyle(.bordered)
                    .tint(Palette.ink)
                Button(go, action: onGo)
                    .buttonStyle(.bordered)
                    .tint(destructive ? Palette.red : Palette.accent)
                    .accessibilityIdentifier("memory-confirm-go")
            }
        }
        .padding(14)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}

/// Editing a memory: the whole file, frontmatter included, in monospace. Save writes it, one commit in a
/// Realm repo. A file outside Realm asks first.
struct MemoryEditor: View {
    let file: MemoryFile
    let profileId: String
    let onSaved: (MemoryFile) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    @State private var saving = false
    @State private var asking = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    init(file: MemoryFile, profileId: String, onSaved: @escaping (MemoryFile) -> Void) {
        self.file = file
        self.profileId = profileId
        self.onSaved = onSaved
        _draft = State(initialValue: file.text)
    }

    private var name: String { file.displayPath.components(separatedBy: "/").last ?? file.title }
    private var dirty: Bool { draft != file.text }

    private var status: String {
        let change = saving ? "Saving…" : dirty ? "Edited" : "No changes"
        let saves = file.external ? "\(MemoryWords.owner(file.source).map { "\($0)'s own file" } ?? "A file"), outside Realm" : "Saving makes one commit"
        return "\(change) · \(saves)"
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                if asking {
                    MemoryConfirm(question: MemoryWords.outsideQuestion(name: name, source: file.source), stay: "Keep editing", go: "Write it") {
                        asking = false
                    } onGo: {
                        asking = false
                        Task { await save(confirmExternal: true) }
                    }
                }
                Text(failure ?? status)
                    .font(.footnote)
                    .foregroundStyle(failure == nil ? Palette.ink3 : Palette.orange)
                    .padding(.horizontal, 16)
                    .accessibilityIdentifier("memory-editor-status")
                TextEditor(text: $draft)
                    .font(RealmType.mono(.callout))
                    .foregroundStyle(Palette.ink)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .scrollContentBackground(.hidden)
                    .focused($focused)
                    .padding(.horizontal, 11)
                    .disabled(saving)
                    .accessibilityIdentifier("memory-editor")
            }
            .padding(.top, 8)
            .background(Ground.grouped)
            .navigationTitle(file.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", systemImage: "checkmark") {
                            if file.external { asking = true } else { Task { await save(confirmExternal: false) } }
                        }
                        .foregroundStyle(dirty ? Palette.ink : Palette.ink3)
                        .disabled(!dirty)
                        .accessibilityIdentifier("memory-save")
                    }
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Ground.grouped)
        .interactiveDismissDisabled(dirty)
    }

    private func save(confirmExternal: Bool) async {
        guard let api = model.api, model.isConnected else {
            failure = AppModel.describe(ChannelError.notConnected)
            return
        }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            onSaved(try await api.writeMemory(id: file.id, profileId: profileId, text: draft, confirmExternal: confirmExternal, baseUpdatedAt: file.updatedAt))
            dismiss()
        } catch ChannelError.rpc(let refusal) {
            failure = refusal.message
        } catch {
            failure = AppModel.describe(error)
        }
    }
}

/// Where a new memory could be saved, and the profile it would be saved for.
struct MemoryHomeChoice: Hashable, Identifiable {
    let profileId: String
    let home: MemoryHome

    var id: String { "\(home.sourceId)/\(home.spaceId ?? "")" }

    static func all(_ memories: [ProfileMemory]) -> [MemoryHomeChoice] {
        memories.flatMap { memory in memory.overview.homes.map { MemoryHomeChoice(profileId: memory.profileId, home: $0) } }
    }
}

/// A new memory, as the desktop's form has it: saved in a Realm repo, in the frontmatter its folders keep,
/// as one commit, and listed in `MEMORY.md`.
struct NewMemorySheet: View {
    let onMade: (MemoryFile, String) -> Void
    private let homes: [MemoryHomeChoice]
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var whereTo: MemoryHomeChoice?
    @State private var type = "project"
    @State private var text = ""
    @State private var saving = false
    @State private var failure: String?

    init(memories: [ProfileMemory], onMade: @escaping (MemoryFile, String) -> Void) {
        homes = MemoryHomeChoice.all(memories)
        self.onMade = onMade
        _whereTo = State(initialValue: homes.first)
    }

    private var ready: Bool {
        whereTo != nil && !saving
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Group {
                if homes.isEmpty {
                    ContentUnavailableView("No memory repo to write in", systemImage: WorkPage.memory.symbol,
                                           description: Text("New memories go in a Realm memory repo. Make one in Profile settings ▸ Memory on your Mac."))
                } else {
                    form
                }
            }
            .navigationTitle("New memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save memory", systemImage: "checkmark") { Task { await save() } }
                            .foregroundStyle(ready ? Palette.ink : Palette.ink3)
                            .disabled(!ready)
                            .accessibilityIdentifier("memory-create")
                    }
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Ground.grouped)
        .interactiveDismissDisabled(!name.isEmpty || !description.isEmpty || !text.isEmpty)
    }

    private var form: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text("Spring creator campaign"))
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("memory-new-name")
                TextField("Description", text: $description, prompt: Text("One line: what it is, so an agent knows when to read it"), axis: .vertical)
                    .lineLimit(1...4)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("memory-new-description")
            } footer: {
                Text(failure ?? "Saved as one commit, and listed in MEMORY.md")
                    .foregroundStyle(failure == nil ? Palette.ink3 : Palette.orange)
            }
            Section {
                Picker("Where", selection: $whereTo) {
                    ForEach(homes) { choice in
                        Text(choice.home.label).tag(Optional(choice))
                    }
                }
                .listRowBackground(Fill.card)
                Picker("Type", selection: $type) {
                    ForEach(MemoryWords.types, id: \.id) { type in
                        Text(type.label).tag(type.id)
                    }
                }
                .listRowBackground(Fill.card)
            }
            Section("Text") {
                TextEditor(text: $text)
                    .font(RealmType.mono(.callout))
                    .frame(minHeight: 180)
                    .scrollContentBackground(.hidden)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("memory-new-text")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
        .disabled(saving)
    }

    private func save() async {
        guard let api = model.api, model.isConnected, let whereTo else {
            failure = AppModel.describe(ChannelError.notConnected)
            return
        }
        saving = true
        failure = nil
        defer { saving = false }
        do {
            let made = try await api.createMemory(profileId: whereTo.profileId, home: whereTo.home, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                                  description: description.trimmingCharacters(in: .whitespacesAndNewlines), type: type, body: text)
            dismiss()
            onMade(made, whereTo.profileId)
        } catch ChannelError.rpc(let refusal) {
            failure = refusal.message
        } catch {
            failure = AppModel.describe(error)
        }
    }
}

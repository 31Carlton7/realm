import RealmKit
import SwiftUI
import UIKit

/// What a new session starts with before the person changes anything: the space the last one went in,
/// where the profile Home shows still has it, else that profile's first; the Mac's own agent where it
/// can run, else the first that can; and that agent's defaults.
enum NewSessionDefaults {
    /// What a new session's words and files are kept under while it is written, beside the sessions'
    /// own drafts: no session's id looks like it.
    static let draft = "new-session"

    /// The spaces a new session can go in: those of the profile Home shows, in the Mac's order.
    static func spaces(_ home: Home, choice: ProfileChoice) -> [Space] {
        home.spaces.filter(choice.includes)
    }

    static func space(lastUsed: String?, in spaces: [Space]) -> Space? {
        spaces.first { $0.id == lastUsed } ?? spaces.first
    }

    /// The agents as the chip lists them: the Mac's own first, then the rest in its order.
    static func agents(_ list: AgentList) -> [AgentOptions] {
        list.agents.filter { $0.kind == list.defaultAgent } + list.agents.filter { $0.kind != list.defaultAgent }
    }

    static func agent(_ list: AgentList) -> AgentOptions? {
        agents(list).first(where: \.available)
    }

    /// An agent's settings as a new session starts on them: its default model, or its first where it
    /// names none, its model's own reasoning, and Build on the Mac's own rung.
    static func options(_ agent: AgentOptions, in list: AgentList) -> SessionOptions {
        let model = agent.models.first { $0.id == nil } ?? agent.models.first
        return SessionOptions(agent: agent, model: model?.id, modelLabel: model?.label ?? agent.name, effort: nil, permissionMode: nil,
                              midTurn: list.midTurn, attachments: list.attachments)
    }

    /// What `session.create` is asked for: only what was chosen, so everything else is the Mac's default.
    static func settings(_ options: SessionOptions) -> SessionChanges {
        let build = options.mode == .build
        return SessionChanges(model: options.model.map { .some($0) }, effort: options.effort.map { .some($0) },
                              mode: build ? nil : options.mode, permission: build ? options.permissionMode : nil)
    }
}

/// Whether Start can go now, and where it cannot, the line under the card that says why.
enum StartState: Equatable {
    case ready
    /// Nothing typed or attached; the field's own words ask for it.
    case empty
    case starting
    case away
    case noSpace
    case noAgent

    init(connected: Bool, space: Space?, agent: AgentOptions?, hasContent: Bool, starting: Bool) {
        if starting {
            self = .starting
        } else if !connected {
            self = .away
        } else if space == nil {
            self = .noSpace
        } else if agent?.available != true {
            self = .noAgent
        } else {
            self = hasContent ? .ready : .empty
        }
    }

    var note: String? {
        switch self {
        case .away: "Start a session while your Mac is connected."
        case .noSpace: "This profile has no spaces. Make one in Realm on your Mac."
        case .noAgent: "No agent on your Mac can start a session. Set one up in Realm on your Mac."
        case .ready, .empty, .starting: nil
        }
    }
}

/// A new session, from Home's compose button: the space it goes in and the agent it is given, as chips
/// over the composer's own card — its model and mode chips, its files, the field — and Start, which
/// makes the session on the Mac with its first message and opens it. Nothing here waits in the outbox:
/// while the Mac is away Start is off, and the words and files stay for when it is back.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var focused: Bool
    @State private var spaceId: String?
    @State private var agentKind: String?
    /// The settings chosen for the agent picked; nil for its defaults.
    @State private var chosen: SessionOptions?
    @State private var settingsShown = false
    @State private var picking: AttachmentPick?
    @State private var previewing: URL?
    @State private var starting = false

    var body: some View {
        let key = NewSessionDefaults.draft
        let list = model.agentList
        let spaces = model.store.home.map { NewSessionDefaults.spaces($0, choice: model.profileChoice) } ?? []
        let space = spaces.first { $0.id == spaceId } ?? NewSessionDefaults.space(lastUsed: model.lastSpace, in: spaces)
        let agents = list.map(NewSessionDefaults.agents) ?? []
        let agent = agents.first { $0.kind == agentKind && $0.available } ?? list.flatMap(NewSessionDefaults.agent)
        let options = chosen.flatMap { $0.agent.kind == agent?.kind ? $0 : nil }
            ?? agent.flatMap { agent in list.map { NewSessionDefaults.options(agent, in: $0) } }
        let text = model.composerDrafts[key] ?? ""
        let attachments = model.draftAttachments[key] ?? []
        let preparing = model.preparingAttachments[key] ?? 0
        let state = StartState(connected: model.isConnected, space: space, agent: agent,
                               hasContent: ComposerAction.hasContent(text: text, attachments: attachments) && preparing == 0,
                               starting: starting)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ScrollView(.horizontal) {
                        HStack(spacing: 0) {
                            SpaceChip(spaces: spaces, space: space) { spaceId = $0 }
                            AgentChip(agents: agents, agent: agent) { kind in
                                agentKind = kind
                                chosen = nil
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                    ComposerLayout(card: true) {
                        if !attachments.isEmpty || preparing > 0 {
                            AttachmentStrip(attachments: attachments, preparing: preparing, files: model.store.files,
                                            open: { previewing = AttachmentStrip.previewLink($0, files: model.store.files) },
                                            remove: { model.removeAttachment($0, from: key) })
                                .layoutValue(key: ComposerPart.self, value: .strip)
                        }
                        TextField(agent.map { "Message \($0.name)" } ?? "Message", text: draft, axis: .vertical)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2...6 : 4...12)
                            .focused($focused)
                            .padding(.vertical, 11)
                            .accessibilityLabel("Message")
                            .layoutValue(key: ComposerPart.self, value: .field)
                        if let list {
                            AddMenu(limits: list.attachments, count: attachments.count + preparing) { picking = $0 }
                                .layoutValue(key: ComposerPart.self, value: .add)
                        }
                        if let agent, let options {
                            SettingChips(label: options.modelLabel, kind: agent.kind, mark: agent.mark, options: options, busy: false,
                                         openSettings: { settingsShown = true }) { changes, _ in chosen = options.applying(changes) }
                                .layoutValue(key: ComposerPart.self, value: .chips)
                        }
                        Button {
                            guard let space, let agent, let options else { return }
                            Task {
                                starting = true
                                if await model.startSession(in: space, agent: agent.kind, settings: NewSessionDefaults.settings(options)) {
                                    dismiss()
                                }
                                starting = false
                            }
                        } label: {
                            if starting {
                                ProgressView()
                                    .frame(width: ComposerLayout.button, height: ComposerLayout.button)
                            } else {
                                PrimaryGlyph(kind: .send, enabled: state == .ready)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(state != .ready)
                        .accessibilityLabel("Start")
                        .accessibilityHint("Starts the session on your Mac with this message, and opens it")
                        .accessibilityShowsLargeContentViewer { Label("Start", systemImage: "arrow.up") }
                        .layoutValue(key: ComposerPart.self, value: .primary)
                    }
                    .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
                    if let note = state.note {
                        Label(note, systemImage: state == .away ? "laptopcomputer" : "info.circle")
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .padding(.horizontal, 4)
                            .padding(.top, 4)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Ground.grouped)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationBackground(Ground.grouped)
        .attachmentPickers($picking, room: (list?.attachments.maxCount ?? 1) - attachments.count - preparing) { sources in
            Task { await model.attach(sources, to: key, limits: list?.attachments) }
        }
        .quickLookPreview($previewing)
        .onChange(of: previewing) { _, now in
            if now == nil { AttachmentStrip.forgetPreviews() }
        }
        .sheet(isPresented: $settingsShown) {
            if let agent, let options {
                SettingsSheetFrame(title: agent.name, kind: agent.kind, mark: agent.mark) {
                    SettingsForm(options: options, busy: nil, footer: "Applies to the session you start.") { changes, _ in
                        chosen = options.applying(changes)
                    }
                }
            }
        }
        .task { await model.loadAgents() }
        // Once the sheet is up rather than as it comes: a field still on its way in cannot take the keyboard.
        .task { focused = true }
    }

    private var draft: Binding<String> {
        let key = NewSessionDefaults.draft
        return Binding(get: { model.composerDrafts[key] ?? "" }, set: { model.composerDrafts[key] = $0 })
    }
}

/// The chip naming the space a new session goes in: a menu of the profile's spaces, each with its mark.
private struct SpaceChip: View {
    let spaces: [Space]
    let space: Space?
    let choose: (String) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            ForEach(spaces) { option in
                Toggle(isOn: Binding(get: { option.id == space?.id }, set: { if $0 { choose(option.id) } })) {
                    Text(option.name)
                    SpaceMark.image(option, picture: model.spacePictures[option.id])
                }
            }
        } label: {
            ChipLabel(text: space?.name ?? "No space", emphasised: true) {
                if let space { SpaceGlyph(space: space, size: 15, relativeTo: .subheadline) }
            }
        }
        .disabled(spaces.isEmpty)
        .accessibilityLabel("Space, \(space?.name ?? "none")")
        .accessibilityHint("Chooses the space the session starts in")
        .accessibilityIdentifier("new-session-space")
    }
}

/// The chip naming the agent a new session is given: a menu of the Mac's agents, its own first. One that
/// cannot run says why under its name, and cannot be picked.
private struct AgentChip: View {
    let agents: [AgentOptions]
    let agent: AgentOptions?
    let choose: (String) -> Void

    var body: some View {
        Menu {
            ForEach(agents, id: \.kind) { option in
                Toggle(isOn: Binding(get: { option.kind == agent?.kind }, set: { if $0 { choose(option.kind) } })) {
                    Text(option.name)
                    if !option.available, let note = option.note { Text(note) }
                    if let mark = Self.mark(option) { mark }
                }
                .disabled(!option.available)
            }
        } label: {
            ChipLabel(text: agent?.name ?? "No agent", emphasised: false) {
                if let agent { AgentMark(kind: agent.kind, mark: agent.mark, colored: true, size: 15, relativeTo: .subheadline) }
            }
        }
        .disabled(agents.isEmpty)
        .accessibilityLabel("Agent, \(agent?.name ?? "none")")
        .accessibilityHint("Chooses the agent the session starts with")
        .accessibilityIdentifier("new-session-agent")
    }

    /// An agent's mark as a menu draws it, which is only ever an image: in its vendor's colour where the
    /// mark has one, as the chip draws it, else in the text's ink. Left to the menu, every mark would wear
    /// the app's accent, as if each were the one chosen.
    private static func mark(_ agent: AgentOptions) -> Image? {
        guard let icon = AgentMark.icon(kind: agent.kind, mark: agent.mark), let image = UIImage(named: "Agents/\(icon)") else { return nil }
        let color = Marks.agentColors[icon].flatMap { Color(hex: $0) }.map { UIColor($0) } ?? .label
        return Image(uiImage: image.withTintColor(color, renderingMode: .alwaysOriginal))
    }
}

/// A space's mark as a menu draws it, which is only ever an image: its glyph in its colour, its emoji
/// drawn into one, or its picture once fetched.
enum SpaceMark {
    static func image(_ space: Space, picture: UIImage?) -> Image {
        switch SpaceIcon(space: space) {
        case .emoji(let emoji): Image(uiImage: ProfileMark.drawn(emoji)).renderingMode(.original)
        case .picture: picture.map { Image(uiImage: $0).renderingMode(.original) } ?? ProfileMark.tinted(UIImage(named: "Spaces/folder"), nil)
        case .glyph(let name):
            ProfileMark.tinted(UIImage(named: "Spaces/\(name)"), space.color?.stringValue.flatMap(SpaceTint.color).map(UIColor.init))
        }
    }
}

extension AppModel {
    /// Where the space the last session started from this phone went is kept: on the phone, per Mac.
    private var lastSpaceKey: String? { store.pairedMac.map { "newSession.space.\($0.macId)" } }

    /// The space the last session started from this phone went in.
    var lastSpace: String? { lastSpaceKey.flatMap(UserDefaults.standard.string(forKey:)) }

    /// The agents a new session could be given, asked again whenever the sheet opens: one may have been
    /// set up or signed out of since. A Mac too old to say has no compose button.
    func loadAgents() async {
        guard let api, isConnected else { return }
        do {
            agentList = try await api.agents()
        } catch ChannelError.rpc(let error) where error.code == "METHOD_NOT_FOUND" {
            agentList = nil
        } catch {
            // What the Mac last said stands: the button stays, and the sheet asks again when it opens.
        }
    }

    /// Makes a session in `space` with the new session's draft as its first message, words and files,
    /// and opens it; the draft is emptied. False where it did not start, and a toast says why: the draft
    /// stays for another go.
    func startSession(in space: Space, agent: String, settings: SessionChanges) async -> Bool {
        let key = NewSessionDefaults.draft
        let text = (composerDrafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = draftAttachments[key] ?? []
        guard let api, isConnected else {
            show(toast: "Start a session while your Mac is connected.")
            return false
        }
        do {
            let uploads = try attachments.map { AttachmentUpload(name: $0.name, mime: $0.mime, bytes: try store.files.bytes(of: $0)) }
            let created = try await api.createSession(spaceId: space.id, agent: agent, text: text, settings: settings, attachments: uploads,
                                                      timeout: MobileAPI.deliveryTimeout(for: uploads))
            if let lastSpaceKey { UserDefaults.standard.set(space.id, forKey: lastSpaceKey) }
            composerDrafts[key] = nil
            for attachment in attachments { removeAttachment(attachment, from: key) }
            path.append(.session(created.id))
            Task { await refreshHome() }
            return true
        } catch {
            show(toast: "The session did not start. \(Self.describe(error))")
            return false
        }
    }
}

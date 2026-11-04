import RealmKit
import SwiftUI

/// What the Edit sheet holds: everything a teammate is that the person chooses here.
struct TeammateDraft: Equatable {
    var name: String
    var brief: String
    var shape: String
    var color: String
    var agentKind: String?
    var model: String?
    var effort: String?
    var permissionMode: String
    var lead: Bool

    /// A new teammate, as the Mac's sheet starts one: no name, an icon rolled for it, the agent last
    /// used on the model last sent on it, and the permission new sessions start in.
    init(agents: AgentList?) {
        name = ""
        brief = ""
        shape = TeammateShape.allCases.randomElement()!.rawValue
        color = TeammatePalette.colors.randomElement()!.name
        let agent = agents?.agents.first { $0.kind == agents?.defaultAgent } ?? agents?.agents.first
        agentKind = agent?.kind
        let last = agent.flatMap { agents?.lastModels?[$0.kind] } ?? nil
        model = agent?.models.contains { $0.id == last } == true ? last : nil
        effort = nil
        permissionMode = agents?.teammatePermission ?? "default"
        lead = false
    }

    init(_ teammate: Teammate) {
        name = teammate.name
        brief = teammate.brief
        shape = teammate.icon?.shape ?? TeammateShape.circle.rawValue
        color = teammate.icon?.color ?? "graphite"
        agentKind = teammate.agentKind
        model = teammate.model
        effort = teammate.effort
        permissionMode = teammate.permissionMode ?? "default"
        lead = teammate.lead
    }

    /// What `teammate.update` is sent: only what changed since the sheet opened.
    func edit(from start: TeammateDraft) -> TeammateEdit {
        var edit = TeammateEdit()
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != start.name { edit.name = trimmed }
        if brief != start.brief { edit.brief = brief }
        if shape != start.shape || color != start.color { edit.icon = TeammateIcon(shape: shape, color: color) }
        if agentKind != start.agentKind, let agentKind { edit.agentKind = agentKind }
        if model != start.model || agentKind != start.agentKind { edit.model = .some(model) }
        if effort != start.effort { edit.effort = .some(effort) }
        if permissionMode != start.permissionMode { edit.permissionMode = permissionMode }
        if lead != start.lead { edit.lead = lead }
        return edit
    }
}

/// A teammate's Edit sheet, as the Mac's: who it is and how it looks — the big preview, its eight
/// shapes drawn in the colour chosen, then the twelve colours — what it does, what it runs on, how
/// freely it acts, and whether it is the Lead. Save sends only what changed; the folder, its group and
/// its clock stay the Mac's to change.
struct TeammateSheet: View {
    let teammateId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var start: TeammateDraft?
    @State private var draft: TeammateDraft?
    @State private var saving = false
    @State private var failure: String?

    /// The three rungs the Mac's sheet offers: Plan and Ask are ways of working a session is switched
    /// into, not how freely a teammate may act.
    static let rungs: [(id: String, label: String)] = [("default", "Ask each time"), ("acceptEdits", "Accept edits"), ("bypassPermissions", "Full access")]

    var body: some View {
        let teammate = model.work.teammate(teammateId)
        NavigationStack {
            Group {
                if let teammate, let binding = Binding($draft) {
                    TeammateForm(draft: binding, agents: model.agentList?.agents ?? [], failure: failure,
                                 note: "Its folder, group and check-in schedule are changed in Realm on your Mac.") {
                        LabeledContent("Handle") {
                            Text("@\(teammate.handle)").mono(.subheadline).foregroundStyle(Palette.ink2)
                        }
                    } place: {
                        EmptyView()
                    }
                    .disabled(saving)
                } else {
                    ContentUnavailableView("This teammate is not on your Mac any more", systemImage: "person.crop.circle.badge.questionmark")
                }
            }
            .navigationTitle(teammate.map { "Edit \($0.name)" } ?? "Edit teammate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", systemImage: "checkmark") { save() }
                            .buttonStyle(.glassProminent)
                            .disabled(!canSave)
                            .accessibilityIdentifier("teammate-save")
                    }
                }
            }
        }
        .onAppear {
            guard draft == nil, let teammate else { return }
            start = TeammateDraft(teammate)
            draft = start
        }
        .interactiveDismissDisabled(saving || (draft != nil && draft != start))
    }

    private var canSave: Bool {
        guard let draft, let start, model.isConnected else { return false }
        return !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !draft.edit(from: start).isEmpty
    }

    private func save() {
        guard let draft, let start, let teammate = model.work.teammate(teammateId) else { return }
        saving = true
        failure = nil
        Task {
            do {
                try await model.work.save(draft.edit(from: start), to: teammate)
                dismiss()
            } catch {
                failure = "Not saved: \(AppModel.describe(error))"
                saving = false
            }
        }
    }
}

/// The New teammate sheet, as the Mac's: a name and the handle made from it, how it looks, what it
/// does, the space it joins, what it runs on and how freely, and whether it is the Lead. Every field but
/// the name starts on a working default, so a name and Create is the whole of making one. Create opens
/// its chat, as the Mac's does.
struct NewTeammateSheet: View {
    let spaces: [Space]
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TeammateDraft
    @State private var spaceId: String
    /// The handle typed, or nil while it follows the name.
    @State private var handle: String?
    @State private var creating = false
    @State private var failure: String?

    init(spaces: [Space], spaceId: String, agents: AgentList?) {
        self.spaces = spaces
        _draft = State(initialValue: TeammateDraft(agents: agents))
        _spaceId = State(initialValue: spaceId)
    }

    var body: some View {
        NavigationStack {
            TeammateForm(draft: $draft, agents: model.agentList?.agents ?? [], failure: failure,
                         note: "It works in the space's folder. A check-in schedule is set in Realm on your Mac.") {
                HandleField(handle: handleText, derived: TeammateWords.handle(from: draft.name), problem: handleProblem)
            } place: {
                if spaces.count > 1 {
                    Section {
                        Picker("Space", selection: $spaceId) {
                            ForEach(spaces) { space in Text(space.name).tag(space.id) }
                        }
                        .accessibilityIdentifier("teammate-space")
                    }
                }
            }
            .disabled(creating)
            .navigationTitle("New teammate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Create", systemImage: "checkmark") { create() }
                            .buttonStyle(.glassProminent)
                            .disabled(!canCreate)
                            .accessibilityIdentifier("teammate-create")
                    }
                }
            }
        }
        .interactiveDismissDisabled(creating || !draft.name.isEmpty)
    }

    private var handleText: Binding<String> {
        Binding(get: { handle ?? "" }, set: { typed in
            let plain = typed.hasPrefix("@") ? String(typed.dropFirst()) : typed
            handle = plain.isEmpty ? nil : plain
        })
    }

    /// The Mac's words for a handle it would refuse, said as it is typed.
    private var handleProblem: String? { handle.flatMap(TeammateWords.handleProblem) }

    private var canCreate: Bool {
        model.isConnected && draft.agentKind != nil && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && handleProblem == nil
    }

    private func create() {
        guard let agentKind = draft.agentKind else { return }
        creating = true
        failure = nil
        let new = NewTeammate(spaceId: spaceId, name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines), handle: handle,
                              brief: draft.brief, icon: TeammateIcon(shape: draft.shape, color: draft.color), agentKind: agentKind,
                              model: draft.model, effort: draft.effort, permissionMode: draft.permissionMode, lead: draft.lead)
        Task {
            do {
                let made = try await model.work.create(new)
                dismiss()
                await model.openTeammate(made)
            } catch {
                failure = "Not created: \(AppModel.describe(error))"
                creating = false
            }
        }
    }
}

/// The handle, made from the name until the person types one of their own.
private struct HandleField: View {
    @Binding var handle: String
    let derived: String
    let problem: String?

    var body: some View {
        LabeledContent {
            HStack(spacing: 0) {
                Text("@").foregroundStyle(Palette.ink3)
                TextField(derived, text: $handle)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .accessibilityIdentifier("teammate-handle")
            }
            .mono(.body)
        } label: {
            Text("Handle")
        }
        if let problem {
            Text(problem)
                .font(.footnote)
                .foregroundStyle(Palette.red)
                .accessibilityIdentifier("teammate-handle-problem")
        }
    }
}

/// What the Edit and New teammate sheets share: the mark and its choices, the name with the handle the
/// sheet shows, what it does, where it goes, what it runs on, how freely it acts, and the Lead.
private struct TeammateForm<Handle: View, Place: View>: View {
    @Binding var draft: TeammateDraft
    let agents: [AgentOptions]
    let failure: String?
    let note: String
    @ViewBuilder let handle: Handle
    @ViewBuilder let place: Place

    var body: some View {
        let agent = agents.first { $0.kind == draft.agentKind }
        Form {
            Section {
                VStack(spacing: 16) {
                    TeammateMark(icon: TeammateIcon(shape: draft.shape, color: draft.color), size: 72, lead: draft.lead)
                        .padding(.top, 4)
                    ShapeChoices(draft: $draft)
                    ColorChoices(draft: $draft)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
            Section("Name") {
                TextField("e.g. CTO", text: $draft.name)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("teammate-name")
                handle
            }
            Section("What it does") {
                TextField("What it owns, how it works, and what it brings back.", text: $draft.brief, axis: .vertical)
                    .lineLimit(3...8)
                    .accessibilityIdentifier("teammate-brief")
            }
            place
            Section("Runs on") {
                if agents.isEmpty {
                    LabeledContent("Agent", value: draft.agentKind.map(AgentNames.label) ?? "—")
                } else {
                    Picker("Agent", selection: agentChoice) {
                        ForEach(agents, id: \.kind) { option in Text(option.name).tag(Optional(option.kind)) }
                    }
                    if let agent {
                        Picker("Model", selection: $draft.model) {
                            ForEach(agent.models, id: \.id) { choice in Text(choice.label).tag(choice.id) }
                        }
                        let efforts = effortChoices(agent)
                        if !efforts.isEmpty {
                            Picker("Reasoning", selection: $draft.effort) {
                                Text("Default").tag(String?.none)
                                ForEach(efforts) { choice in Text(choice.label).tag(Optional(choice.id)) }
                            }
                        }
                    }
                }
            }
            Section {
                Picker("Permissions", selection: $draft.permissionMode) {
                    ForEach(TeammateSheet.rungs, id: \.id) { rung in Text(rung.label).tag(rung.id) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Permissions")
            } footer: {
                Text("The sessions it starts run this way.")
            }
            Section {
                Toggle(isOn: $draft.lead) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Make this the Lead")
                        Text("First in the list. Routes your asks to the right teammate.")
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                .tint(Palette.accent)
            } footer: {
                if let failure {
                    Text(failure).foregroundStyle(Palette.red)
                } else {
                    Text(note)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
    }

    /// Another agent starts on its own default model and reasoning.
    private var agentChoice: Binding<String?> {
        Binding(get: { draft.agentKind }, set: { kind in
            guard kind != draft.agentKind else { return }
            draft.agentKind = kind
            draft.model = nil
            draft.effort = nil
        })
    }

    /// The reasoning levels the model chosen takes, else the agent's own.
    private func effortChoices(_ agent: AgentOptions) -> [Choice] {
        agent.models.first { $0.id == draft.model }?.efforts ?? agent.efforts
    }
}

/// The eight shapes, each drawn in the colour chosen, the chosen one on the pill's grey.
private struct ShapeChoices: View {
    @Binding var draft: TeammateDraft

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
            ForEach(TeammateShape.allCases, id: \.self) { shape in
                let chosen = shape.rawValue == draft.shape
                Button {
                    draft.shape = shape.rawValue
                } label: {
                    TeammateMark(icon: TeammateIcon(shape: shape.rawValue, color: draft.color), size: 34)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(chosen ? Fill.bubble : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(shape.label)
                .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
            }
        }
        .sensoryFeedback(.selection, trigger: draft.shape)
    }
}

/// The twelve colours, as swatches of the body they give.
private struct ColorChoices: View {
    @Binding var draft: TeammateDraft

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 10) {
            ForEach(TeammatePalette.colors, id: \.name) { color in
                let chosen = color.name == draft.color
                Button {
                    draft.color = color.name
                } label: {
                    Circle()
                        .fill(TeammatePalette.body(color.name))
                        .frame(width: 30, height: 30)
                        .padding(3)
                        .overlay {
                            if chosen { Circle().strokeBorder(Palette.ink, lineWidth: 2) }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(color.label)
                .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
            }
        }
        .sensoryFeedback(.selection, trigger: draft.color)
    }
}

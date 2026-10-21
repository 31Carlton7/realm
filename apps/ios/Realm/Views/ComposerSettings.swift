import RealmKit
import SwiftUI

/// A setting of a session's that a change can be on its way to the Mac for.
enum SessionSetting: Equatable {
    case model, effort, mode, permission

    /// The setting, as the start of a sentence: "The model did not change."
    var word: String {
        switch self {
        case .model: "The model"
        case .effort: "The reasoning"
        case .mode: "The mode"
        case .permission: "The permission"
        }
    }
}

/// How the composer and the settings sheet say a session's mode and permissions: a glyph for each, and
/// what each lets the agent do.
enum SettingWords {
    static func line(_ mode: SessionMode) -> String {
        switch mode {
        case .build: "Changes files and runs commands as its permissions allow."
        case .plan: "Plans first, and changes nothing until you approve the plan."
        case .ask: "Answers questions and changes nothing."
        }
    }

    static func symbol(_ mode: SessionMode) -> String {
        switch mode {
        case .build: "hammer"
        case .plan: "list.bullet.clipboard"
        case .ask: "questionmark.bubble"
        }
    }

    /// What a permission rung lets the agent do, for the rungs Realm has.
    static func line(permission id: String) -> String? {
        switch id {
        case "default": "Asks before each edit and command."
        case "acceptEdits": "Edits files without asking, and asks before commands."
        case "bypassPermissions": "Runs everything without asking."
        default: nil
        }
    }

    static func symbol(permission id: String) -> String {
        switch id {
        case "acceptEdits": "pencil"
        case "bypassPermissions": "exclamationmark.shield"
        default: "hand.raised"
        }
    }

    /// What the mode chip says: in Build, the rung the agent is on; in Plan or Ask, the mode. Build on a
    /// rung not yet known says Build.
    static func chip(_ options: SessionOptions) -> (label: String, symbol: String) {
        let mode = options.mode
        guard mode == .build else {
            let label = options.agent.modes.first { $0.id == mode.rawValue }?.label ?? mode.rawValue.capitalized
            return (label, symbol(mode))
        }
        if let id = options.permissionMode, let rung = options.agent.permissions.first(where: { $0.id == id }) {
            return (rung.label, symbol(permission: id))
        }
        return (options.agent.modes.first { $0.id == "build" }?.label ?? "Build", symbol(.build))
    }
}

/// The chips on the composer's toolbar: the model, which opens the session's settings, and the mode,
/// a menu of its own. They scroll sideways where the text is too large for them to fit.
struct ComposerChips: View {
    let sessionId: String
    let openSettings: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let options = model.sessionOptions[sessionId]
        let session = model.store.transcript(sessionId).session
        // Before the Mac answers, or from one too old to, the session's own row names the model.
        let label = options?.modelLabel ?? session?.modelDisplayName ?? session?.agentDisplayName ?? "Model"
        ScrollView(.horizontal) {
            HStack(spacing: 0) {
                Button(action: openSettings) {
                    ChipLabel(text: label, emphasised: true) {
                        AgentMark(kind: options?.agent.kind ?? session?.agent ?? "", mark: options?.agent.mark ?? session?.agentMark,
                                  colored: true, size: 15, relativeTo: .subheadline)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Model, \(label)")
                .accessibilityHint("Opens the model, reasoning and mode")
                if let options, options.agent.modes.count > 1 || !options.agent.permissions.isEmpty {
                    ModeMenu(options: options, sessionId: sessionId)
                }
            }
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

/// A chip's face: quiet words with a glyph and a chevron, drawn on the composer's own glass rather than
/// as a pill of their own. Its touch is a full 44 points tall.
private struct ChipLabel<Icon: View>: View {
    let text: String
    /// The model's chip reads in ink; the rest in the quieter ink beside it.
    let emphasised: Bool
    @ViewBuilder let icon: Icon

    var body: some View {
        HStack(spacing: 6) {
            icon
            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(emphasised ? Palette.ink : Palette.ink2)
                .lineLimit(1)
                .fixedSize()
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Palette.ink3)
        }
        .padding(.horizontal, 8)
        .frame(minHeight: ComposerLayout.button)
        .contentShape(Rectangle())
    }
}

/// The mode chip: a menu of the modes the agent offers, then, in Build, its permission rungs. Two taps
/// change either.
private struct ModeMenu: View {
    let options: SessionOptions
    let sessionId: String
    @Environment(AppModel.self) private var model

    var body: some View {
        let chip = SettingWords.chip(options)
        Menu {
            if options.agent.modes.count > 1 {
                Picker("Mode", selection: mode) {
                    ForEach(options.agent.modes) { choice in
                        if let mode = SessionMode(rawValue: choice.id) {
                            Label(choice.label, systemImage: SettingWords.symbol(mode)).tag(mode)
                        }
                    }
                }
                .pickerStyle(.inline)
            }
            if options.mode == .build, !options.agent.permissions.isEmpty {
                Picker("Permissions", selection: permission) {
                    ForEach(options.agent.permissions) { choice in
                        Label(choice.label, systemImage: SettingWords.symbol(permission: choice.id)).tag(Optional(choice.id))
                    }
                }
                .pickerStyle(.inline)
            }
        } label: {
            ChipLabel(text: chip.label, emphasised: false) {
                Image(systemName: chip.symbol)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink2)
            }
        }
        .accessibilityLabel("Mode, \(chip.label)")
        .accessibilityHint("Changes what the agent may do")
    }

    private var mode: Binding<SessionMode> {
        Binding(get: { options.mode }, set: { chosen in
            Task { await model.configure(SessionChanges(mode: chosen), .mode, in: sessionId) }
        })
    }

    private var permission: Binding<String?> {
        Binding(get: { options.permissionMode }, set: { chosen in
            guard let chosen else { return }
            Task { await model.configure(SessionChanges(permission: chosen), .permission, in: sessionId) }
        })
    }
}

/// A session's settings, from the composer's model chip: the model, its reasoning, the mode, and in
/// Build how freely the agent may act. Each change goes to the Mac at once and shows as made while it
/// travels, with a spinner beside it; a refusal puts it back. While the Mac is away it shows what was
/// last known, and changes nothing.
struct SessionSettingsSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picks = 0

    var body: some View {
        let options = model.sessionOptions[sessionId]
        let session = model.store.transcript(sessionId).session
        let away = !model.isConnected
        NavigationStack {
            Form {
                if away {
                    Section {
                        Label("Connect to your Mac to change these.", systemImage: "laptopcomputer")
                            .foregroundStyle(Palette.ink2)
                            .listRowBackground(Fill.card)
                    }
                }
                if let options {
                    settings(options)
                        .disabled(away)
                } else {
                    Section {
                        if let label = session?.modelDisplayName {
                            LabeledContent("Model", value: label)
                                .listRowBackground(Fill.card)
                        }
                        if !away, model.optionsUnanswered.contains(sessionId) {
                            Text("Update Realm on your Mac to change these from iPhone.")
                                .foregroundStyle(Palette.ink2)
                                .listRowBackground(Fill.card)
                        } else if !away {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .listRowBackground(Fill.card)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .navigationTitle(options?.agent.name ?? session?.agentDisplayName ?? "Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        AgentMark(kind: options?.agent.kind ?? session?.agent ?? "", mark: options?.agent.mark ?? session?.agentMark,
                                  colored: true, size: 17, relativeTo: .headline)
                        Text(options?.agent.name ?? session?.agentDisplayName ?? "Session")
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .sensoryFeedback(.selection, trigger: picks)
        .task { await model.loadOptions(sessionId) }
    }

    @ViewBuilder
    private func settings(_ options: SessionOptions) -> some View {
        let busy = model.configuring[sessionId]
        Section("Model") {
            ForEach(Array(options.agent.models.enumerated()), id: \.offset) { _, choice in
                // The agent's own default reads as Default, with the model it is under it.
                let title = choice.id == nil ? "Default" : choice.label
                let line = choice.id == nil && choice.label != "Default" ? choice.label : nil
                row(title, line: line, chosen: options.model == choice.id, busy: busy == .model) {
                    configure(SessionChanges(model: .some(choice.id)), .model)
                }
            }
        }
        if !options.efforts.isEmpty {
            Section {
                Picker(selection: effort(options)) {
                    Text("Default").tag(String?.none)
                    ForEach(options.efforts) { choice in
                        Text(choice.label).tag(Optional(choice.id))
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text("Reasoning")
                        if busy == .effort { ProgressView().controlSize(.small) }
                    }
                }
                .pickerStyle(.menu)
                .tint(Palette.ink2)
                .listRowBackground(Fill.card)
            }
        }
        if options.agent.modes.count > 1 {
            Section {
                Picker("Mode", selection: mode(options)) {
                    ForEach(options.agent.modes) { choice in
                        if let mode = SessionMode(rawValue: choice.id) { Text(choice.label).tag(mode) }
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } header: {
                HStack(spacing: 8) {
                    Text("Mode")
                    if busy == .mode { ProgressView().controlSize(.mini) }
                }
            } footer: {
                Text(SettingWords.line(options.mode))
            }
        }
        if options.mode == .build, !options.agent.permissions.isEmpty {
            Section("Permissions") {
                ForEach(options.agent.permissions) { choice in
                    row(choice.label, line: SettingWords.line(permission: choice.id), chosen: options.permissionMode == choice.id,
                        busy: busy == .permission) {
                        configure(SessionChanges(permission: choice.id), .permission)
                    }
                }
            }
        }
        Section {
        } footer: {
            Text("Changes apply from your next message.")
        }
    }

    /// A choice: its name, a line under it where it needs one, and a check on the one chosen, which is a
    /// spinner while the change is on its way.
    private func row(_ title: String, line: String?, chosen: Bool, busy: Bool, choose: @escaping () -> Void) -> some View {
        Button(action: choose) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                    if let line {
                        Text(line)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if chosen && busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.accent)
                        .opacity(chosen ? 1 : 0)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Fill.card)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private func configure(_ changes: SessionChanges, _ setting: SessionSetting) {
        picks += 1
        Task { await model.configure(changes, setting, in: sessionId) }
    }

    private func effort(_ options: SessionOptions) -> Binding<String?> {
        Binding(get: { options.effort }, set: { configure(SessionChanges(effort: .some($0)), .effort) })
    }

    private func mode(_ options: SessionOptions) -> Binding<SessionMode> {
        Binding(get: { options.mode }, set: { configure(SessionChanges(mode: $0), .mode) })
    }
}

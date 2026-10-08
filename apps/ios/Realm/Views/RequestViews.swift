import RealmKit
import SwiftUI

/// A permission, a plan or questions the agent is blocked on, answered in place. The answer is the
/// person's from the press, and shows as Sending… until the Mac takes it; leaving, or putting a sheet
/// away, answers nothing.
struct RequestCard: View {
    let request: TranscriptRow.Request
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var answering = false

    var body: some View {
        let pending = model.store.outbox.answer(for: request.requestId)
        VStack(alignment: .leading, spacing: 12) {
            head
            if !request.tool.isEmpty, request.kind == .permission {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(request.tool)
                        .inter(.subheadline, .medium)
                        .foregroundStyle(Palette.ink)
                        .fixedSize()
                    if !request.summary.isEmpty, request.summary != request.tool {
                        Text(request.summary)
                            .mono(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
            }
            switch request.state {
            case .pending:
                if let pending {
                    chosen(pending)
                } else {
                    actions
                }
            case .allowed, .denied:
                EmptyView()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
        .sheet(isPresented: $answering) {
            QuestionSheet(draft: model.store.draft(for: request, in: sessionId), asker: asker)
        }
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .inter(.body, .title)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            stateLabel
                .fixedSize()
        }
    }

    private var title: String {
        switch request.kind {
        case .questions: "\(asker) asks"
        case .plan: "A plan to approve"
        case .permission: request.title.isEmpty ? "Allow \(request.tool)?" : request.title
        }
    }

    private var asker: String {
        AgentNames.label(model.store.transcript(sessionId).session?.agent ?? "")
    }

    @ViewBuilder
    private var stateLabel: some View {
        switch request.state {
        case .pending:
            word("Waiting on you", symbol: "hand.raised", tone: .waiting)
        case .allowed:
            let answered: String = switch request.kind {
            case .questions: "Answered"
            case .plan: "Approved"
            case .permission: "Allowed"
            }
            word(answered, symbol: "checkmark.circle", tone: .done)
        case .denied:
            let declined: String = switch request.kind {
            case .questions: "Skipped"
            case .plan: "Kept planning"
            case .permission: "Denied"
            }
            word(declined, symbol: "xmark.circle", tone: .quiet)
        }
    }

    private func word(_ text: String, symbol: String, tone: Tone) -> some View {
        Label(text, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .inter(.footnote, .medium)
            .foregroundStyle(tone.color)
    }

    @ViewBuilder
    private var actions: some View {
        switch request.kind {
        case .permission:
            HStack(spacing: 10) {
                Button("Allow") { model.answer(.allow, to: request, in: sessionId) }
                    .buttonStyle(RealmButtonStyle(primary: true))
                Button("Deny") { model.answer(.deny, to: request, in: sessionId) }
                    .buttonStyle(RealmButtonStyle(primary: false))
            }
        case .plan:
            VStack(alignment: .leading, spacing: 10) {
                if !request.summary.isEmpty {
                    MarkdownView(request.summary)
                }
                Text("Ready to build this?")
                    .inter(.subheadline)
                    .foregroundStyle(Palette.ink2)
                HStack(spacing: 10) {
                    Button("Implement this plan") { model.answer(.allow, to: request, in: sessionId) }
                        .buttonStyle(RealmButtonStyle(primary: true))
                    Button("Keep planning") { model.answer(.deny, to: request, in: sessionId) }
                        .buttonStyle(RealmButtonStyle(primary: false))
                }
            }
        case .questions(let questions):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions, id: \.question) { question in
                    VStack(alignment: .leading, spacing: 2) {
                        if !question.header.isEmpty {
                            Text(question.header)
                                .inter(.footnote, .medium)
                                .foregroundStyle(Palette.ink2)
                        }
                        Text(question.question)
                            .inter(.body)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 10) {
                    Button(model.store.drafts[request.requestId] == nil ? "Answer" : "Continue answering") { answering = true }
                        .buttonStyle(RealmButtonStyle(primary: true))
                    Button("Skip") { model.answer(.deny, to: request, in: sessionId) }
                        .buttonStyle(RealmButtonStyle(primary: false))
                }
            }
        }
    }

    /// The answer given and where it is: on its way, waiting for the Mac, or refused.
    private func chosen(_ item: OutgoingItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .answer(_, let decision, let answers) = item.payload {
                Text(Self.describe(decision, answers: answers, kind: request.kind))
                    .inter(.subheadline, .medium)
                    .foregroundStyle(Palette.ink)
            }
            OutgoingStatusView(item: item, alignment: .leading)
            if item.state == .waiting {
                Button("Don't send") { model.discard(item) }
                    .buttonStyle(RealmButtonStyle(primary: false))
            }
        }
    }

    static func describe(_ decision: Decision, answers: [String: String]?, kind: TranscriptRow.RequestKind) -> String {
        switch (kind, decision) {
        case (.questions, .deny): "You skipped these questions."
        case (.questions, _): (answers ?? [:]).sorted { $0.key < $1.key }.map(\.value).joined(separator: "; ")
        case (.plan, .deny): "You chose to keep planning."
        case (.plan, _): "You approved the plan."
        case (.permission, .deny): "You denied it."
        case (.permission, _): "You allowed it."
        }
    }
}

/// A button on Realm's own surface: the accent for the one primary action, a quiet fill otherwise. A
/// press is a fill, not a size, and every one is at least 44 points tall.
struct RealmButtonStyle: ButtonStyle {
    let primary: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .inter(.body, .medium)
            .foregroundStyle(primary ? Color.white : Palette.ink)
            .opacity(isEnabled ? 1 : 0.5)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(fill(pressed: configuration.isPressed), in: RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.control + 2, style: .continuous))
    }

    private func fill(pressed: Bool) -> Color {
        if primary { return pressed ? Palette.accent.opacity(0.8) : Palette.accent }
        return pressed ? Palette.hover2 : Palette.hover
    }
}

/// The questions, answered in a sheet: one card for all of them, saying who asks. Its picks are kept
/// as they are made; putting it away — Not now, or a swipe — sends nothing. Only Send answers.
struct QuestionSheet: View {
    @State var draft: AnswerDraft
    let asker: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    ForEach(draft.questions, id: \.question) { question in
                        QuestionBlock(question: question, draft: $draft)
                    }
                }
                .padding(16)
            }
            .background(Palette.canvas)
            .navigationTitle("\(asker) asks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        model.submit(draft)
                        dismiss()
                    }
                    .disabled(!draft.isComplete)
                }
            }
        }
        .onChange(of: draft) { _, changed in model.store.keepDraft(changed) }
    }
}

private struct QuestionBlock: View {
    let question: Question
    @Binding var draft: AnswerDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !question.header.isEmpty {
                Text(question.header)
                    .inter(.footnote, .medium)
                    .foregroundStyle(Palette.ink2)
                    .accessibilityAddTraits(.isHeader)
            }
            Text(question.question)
                .inter(.body, .title)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            if question.multiSelect {
                Text("Choose any that apply.")
                    .inter(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            VStack(spacing: 8) {
                ForEach(question.options, id: \.label) { option in
                    optionRow(option)
                }
            }
            if question.takesText {
                Group {
                    if question.secret {
                        SecureField(question.options.isEmpty ? "Your answer" : "Something else", text: other)
                    } else {
                        TextField(question.options.isEmpty ? "Your answer" : "Something else", text: other, axis: .vertical)
                            .lineLimit(1...4)
                    }
                }
                .inter(.body)
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .surface(Palette.field, radius: Radius.card)
                .accessibilityLabel(question.options.isEmpty ? "Your answer" : "Another answer, in your words")
            }
        }
    }

    private var other: Binding<String> {
        Binding(get: { draft.other(for: question) }, set: { draft.setOther($0, for: question) })
    }

    private func optionRow(_ option: QuestionOption) -> some View {
        let chosen = draft.isPicked(option.label, in: question)
        let symbol = question.multiSelect
            ? (chosen ? "checkmark.square.fill" : "square")
            : (chosen ? "largecircle.fill.circle" : "circle")
        return Button {
            draft.toggle(option.label, in: question)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(chosen ? Palette.accent : Palette.ink2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .inter(.body, .medium)
                        .foregroundStyle(Palette.ink)
                    if let description = option.description {
                        Text(description)
                            .inter(.subheadline)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .surface(chosen ? Palette.accentTint : Palette.surface, radius: Radius.card)
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityValue(option.description ?? "")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

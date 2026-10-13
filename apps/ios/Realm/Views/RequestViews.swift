import RealmKit
import SwiftUI

/// A permission, a plan or questions the agent is blocked on, answered in place. It says who is asking
/// first. The answer is the person's from the press, and shows as Sending… until the Mac takes it;
/// leaving, or putting a sheet away, answers nothing.
struct RequestCard: View {
    let request: TranscriptRow.Request
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var answering = false

    var body: some View {
        let pending = model.store.outbox.answer(for: request.requestId)
        let agent = model.store.transcript(sessionId).session?.agent ?? ""
        VStack(alignment: .leading, spacing: 12) {
            // Who asks, and where the request is; one above the other where both will not fit a line.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    askerLabel(agent)
                    Spacer(minLength: 8)
                    stateLabel
                }
                VStack(alignment: .leading, spacing: 6) {
                    askerLabel(agent)
                    stateLabel
                }
            }
            if let title {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            subject
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
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
        .environment(\.proseGround, .card)
        .sheet(isPresented: $answering) {
            QuestionSheet(draft: model.store.draft(for: request, in: sessionId), asker: Self.asker(agent))
        }
    }

    private func askerLabel(_ agent: String) -> some View {
        HStack(spacing: 6) {
            AgentMark(kind: agent, colored: true, size: 15, relativeTo: .subheadline)
            Text("\(Self.asker(agent)) asks")
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Palette.ink2)
        .accessibilityElement(children: .combine)
    }

    /// Who is asking, by the agent's name; an agent the session does not name is "The agent".
    static func asker(_ agent: String) -> String {
        agent.isEmpty ? "The agent" : AgentNames.label(agent)
    }

    /// The card's head under the asker: the permission's own words, or what a plan is. Questions need
    /// none; they are the head.
    private var title: String? {
        switch request.kind {
        case .questions: nil
        case .plan: "A plan to approve"
        case .permission: request.title.isEmpty ? "Allow \(request.tool)?" : request.title
        }
    }

    /// What is asked about: the command or file a permission is for, a plan's text, the questions.
    @ViewBuilder
    private var subject: some View {
        switch request.kind {
        case .permission:
            if !request.tool.isEmpty || !request.summary.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if !request.tool.isEmpty, !(title ?? "").contains(request.tool) {
                        Text(request.tool)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.ink2)
                    }
                    if !request.summary.isEmpty, request.summary != request.tool {
                        Text(request.summary)
                            .mono(.footnote)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(6)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Fill.well, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        case .plan:
            // The plan's steps go here once the Mac sends them with the request; its text is the summary.
            if !request.summary.isEmpty {
                MarkdownView(request.summary)
            }
        case .questions(let questions):
            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions, id: \.question) { question in
                    VStack(alignment: .leading, spacing: 2) {
                        if !question.header.isEmpty {
                            Text(question.header)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(Palette.ink2)
                        }
                        Text(question.question)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder
    private var stateLabel: some View {
        switch request.state {
        case .pending:
            word("Waiting on you", symbol: "hand.raised.fill", tone: .waiting)
        case .allowed:
            let answered: String = switch request.kind {
            case .questions: "Answered"
            case .plan: "Approved"
            case .permission: "Allowed"
            }
            word(answered, symbol: "checkmark.circle.fill", tone: .done)
        case .denied:
            let declined: String = switch request.kind {
            case .questions: "Skipped"
            case .plan: "Kept planning"
            case .permission: "Denied"
            }
            word(declined, symbol: "xmark.circle.fill", tone: .quiet)
        }
    }

    private func word(_ text: String, symbol: String, tone: Tone) -> some View {
        Label(text, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .symbolRenderingMode(.hierarchical)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(tone.color)
    }

    /// The two answers, side by side: the one that lets the agent go on is the accent, at the end.
    @ViewBuilder
    private var actions: some View {
        switch request.kind {
        case .permission:
            AnswerButtons(decline: "Deny", accept: "Allow",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { model.answer(.allow, to: request, in: sessionId) })
        case .plan:
            AnswerButtons(decline: "Keep planning", accept: "Implement this plan",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { model.answer(.allow, to: request, in: sessionId) })
        case .questions:
            AnswerButtons(decline: "Skip", accept: model.store.drafts[request.requestId] == nil ? "Answer" : "Continue answering",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { answering = true })
        }
    }

    /// The answer given and where it is: on its way, waiting for the Mac, or refused.
    private func chosen(_ item: OutgoingItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .answer(_, let decision, let answers) = item.payload {
                Text(Self.describe(decision, answers: answers, kind: request.kind))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
            }
            OutgoingStatusView(item: item, alignment: .leading)
            if item.state == .waiting {
                Button("Don't send") { model.discard(item) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(Palette.ink)
            }
        }
    }

    /// The answer given, as the card shows it while it travels: answers in the questions' order, and a
    /// secret one only as its mark.
    static func describe(_ decision: Decision, answers: [String: String]?, kind: TranscriptRow.RequestKind) -> String {
        switch (kind, decision) {
        case (.questions, .deny):
            return "You skipped these questions."
        case (.questions(let questions), _):
            let given = questions.compactMap { question in answers?[question.question].map { question.secret ? "••••••" : $0 } }
            return "You answered: \(given.joined(separator: " · "))"
        case (.plan, .deny): return "You chose to keep planning."
        case (.plan, _): return "You approved the plan."
        case (.permission, .deny): return "You denied it."
        case (.permission, _): return "You allowed it."
        }
    }
}

/// A decline and an accept as two capsules sharing the card's width. Where both words do not fit on
/// one line — a long label, or the accessibility sizes — they stack, the accept first.
private struct AnswerButtons: View {
    let decline: String
    let accept: String
    let onDecline: () -> Void
    let onAccept: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            EqualWidths(spacing: 10) {
                declineButton
                acceptButton
            }
            VStack(spacing: 10) {
                acceptButton
                declineButton
            }
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .font(.body.weight(.semibold))
    }

    private var declineButton: some View {
        Button(action: onDecline) {
            Text(decline)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(Palette.ink)
    }

    private var acceptButton: some View {
        Button(action: onAccept) {
            Text(accept)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
    }
}

/// Its children side by side at one width, sharing what it is given. Its ideal width is what the
/// widest needs, times the count, so a label that would not fit in its share makes the row not fit.
struct EqualWidths: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let ideals = subviews.map { $0.sizeThatFits(.unspecified) }
        let gaps = spacing * CGFloat(subviews.count - 1)
        let needed = (ideals.map(\.width).max() ?? 0) * CGFloat(subviews.count) + gaps
        return CGSize(width: proposal.width ?? needed, height: ideals.map(\.height).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let width = (bounds.width - spacing * CGFloat(subviews.count - 1)) / CGFloat(subviews.count)
        for (index, subview) in subviews.enumerated() {
            let x = bounds.minX + CGFloat(index) * (width + spacing)
            subview.place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: width, height: bounds.height))
        }
    }
}

/// The questions, answered in a sheet: one section for each, saying who asks. Its picks are kept as
/// they are made; putting it away — Not now, or a swipe — sends nothing. Only Send answers.
struct QuestionSheet: View {
    @State var draft: AnswerDraft
    let asker: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picks = 0

    var body: some View {
        NavigationStack {
            Form {
                ForEach(draft.questions, id: \.question) { question in
                    QuestionSection(question: question, draft: $draft, picked: { picks += 1 })
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
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
        .presentationDetents([.large])
        .sensoryFeedback(.selection, trigger: picks)
        .onChange(of: draft) { _, changed in model.store.keepDraft(changed) }
    }
}

/// One question: its header and words at the section's head, its options as rows that take a
/// checkmark, and a field for an answer of the person's own where the agent takes one.
private struct QuestionSection: View {
    let question: Question
    @Binding var draft: AnswerDraft
    let picked: () -> Void
    @FocusState private var typing: Bool

    var body: some View {
        Section {
            ForEach(question.options, id: \.label) { option in
                optionRow(option)
            }
            if question.takesText {
                otherRow
            }
        } header: {
            VStack(alignment: .leading, spacing: 4) {
                if !question.header.isEmpty {
                    Text(question.header)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                }
                Text(question.question)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .textCase(nil)
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        } footer: {
            if question.secret {
                Label("Your Mac keeps only a mark of this answer.", systemImage: "lock.fill")
            } else if question.multiSelect {
                Text("Choose any that apply.")
            }
        }
    }

    private func optionRow(_ option: QuestionOption) -> some View {
        let chosen = draft.isPicked(option.label, in: question)
        return Button {
            draft.toggle(option.label, in: question)
            typing = false
            picked()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                if question.multiSelect {
                    Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(chosen ? Palette.accent : Palette.ink3)
                        .font(.title3)
                        .contentTransition(.symbolEffect(.replace))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                    if let description = option.description {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                Spacer(minLength: 8)
                if !question.multiSelect {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Palette.accent)
                        .opacity(chosen ? 1 : 0)
                }
            }
            .frame(minHeight: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Fill.card)
        .accessibilityLabel(option.label)
        .accessibilityValue(option.description ?? "")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// An answer of the person's own: on a single-choice question it stands instead of an option, and
    /// takes the checkmark while it has words.
    private var otherRow: some View {
        let own = !draft.other(for: question).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let placeholder = question.options.isEmpty ? "Your answer" : "Other"
        return HStack(spacing: 12) {
            if question.secret {
                Image(systemName: "key.fill")
                    .foregroundStyle(Palette.ink3)
                    .accessibilityHidden(true)
                SecureField(placeholder, text: other)
                    .textContentType(.password)
                    .focused($typing)
                    .accessibilityLabel(fieldLabel)
            } else {
                TextField(placeholder, text: other, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($typing)
                    .accessibilityLabel(fieldLabel)
            }
            if !question.options.isEmpty, !question.multiSelect {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.accent)
                    .opacity(own ? 1 : 0)
                    .accessibilityHidden(true)
            }
        }
        .font(.body)
        .foregroundStyle(Palette.ink)
        .frame(minHeight: 30)
        .listRowBackground(Fill.card)
    }

    private var fieldLabel: String {
        question.options.isEmpty ? "Your answer" : "Another answer, in your words"
    }

    private var other: Binding<String> {
        Binding(get: { draft.other(for: question) }, set: { draft.setOther($0, for: question) })
    }
}

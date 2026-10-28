import RealmKit
import SwiftUI

/// The request a session waits on the person for — the oldest still pending — and the answer given
/// to it, if one is on its way. It is what the card docked over the composer holds.
struct PendingRequest: Equatable {
    let request: TranscriptRow.Request
    let answer: OutgoingItem?

    static func first(in transcript: Transcript, outbox: Outbox) -> PendingRequest? {
        for row in transcript.rows {
            guard case .request(let request) = row.content, request.state == .pending else { continue }
            return PendingRequest(request: request, answer: outbox.answer(for: request.requestId))
        }
        return nil
    }
}

/// Who asks a request: the name the Mac gives the asker ("Codex", "Linear's MCP server"), else the
/// session's agent, else "The agent".
enum Asker {
    static func name(_ request: TranscriptRow.Request, agent: String) -> String {
        if let asker = request.asker, !asker.isEmpty { return asker }
        return agent.isEmpty ? "The agent" : AgentNames.label(agent)
    }
}

/// A permission, a plan or questions in the transcript: it says who is asking first, what is asked,
/// and where it stands. It is answered from the card docked over the composer; answered, it stays
/// where it was asked as the question and its answer, a secret one only as its mark.
struct RequestCard: View {
    let request: TranscriptRow.Request
    let sessionId: String
    @Environment(AppModel.self) private var model

    var body: some View {
        let session = model.store.transcript(sessionId).session
        VStack(alignment: .leading, spacing: 12) {
            // Who asks, and where the request is; one above the other where both will not fit a line.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    askerLabel(session)
                    Spacer(minLength: 8)
                    stateLabel
                }
                VStack(alignment: .leading, spacing: 6) {
                    askerLabel(session)
                    stateLabel
                }
            }
            if let title = Self.title(request) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            RequestSubject(request: request)
            if let answered = Self.answered(request) {
                Text(answered)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
        .environment(\.proseGround, .card)
    }

    private func askerLabel(_ session: SessionRow?) -> some View {
        HStack(spacing: 6) {
            AgentMark(kind: session?.agent ?? "", mark: session?.agentMark, colored: true, size: 15, relativeTo: .subheadline)
            Text("\(Asker.name(request, agent: session?.agent ?? "")) asks")
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Palette.ink2)
        .accessibilityElement(children: .combine)
    }

    /// The card's head under the asker: the permission's own words, or what a plan is. Questions need
    /// none; they are the head.
    static func title(_ request: TranscriptRow.Request) -> String? {
        switch request.kind {
        case .questions: nil
        case .plan: "A plan to approve"
        case .permission: request.title.isEmpty ? "Allow \(request.tool)?" : request.title
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

    /// The answers the Mac logged for an answered request, one per line by the question's head, a
    /// secret one only as its mark.
    static func answered(_ request: TranscriptRow.Request) -> String? {
        guard let answers = request.answers, !answers.isEmpty, let questions = request.questions else { return nil }
        let lines = questions.compactMap { question -> String? in
            guard let value = answers[question.answerKey] else { return nil }
            let head = question.header.isEmpty ? question.question : question.header
            return "\(head): \(question.secret ? "••••••" : value.text)"
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// The answer given, as it shows while it travels: answers in the questions' order, and a secret
    /// one only as its mark.
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

/// What a request is about: the command or file a permission is for, a plan's steps and text, the
/// questions and what the asker said they are for.
private struct RequestSubject: View {
    let request: TranscriptRow.Request

    var body: some View {
        switch request.kind {
        case .permission:
            if !request.summary.isEmpty, request.summary != request.tool {
                VStack(alignment: .leading, spacing: 4) {
                    if !request.tool.isEmpty, !(RequestCard.title(request) ?? "").contains(request.tool) {
                        Text(request.tool)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Palette.ink2)
                    }
                    Text(request.summary)
                        .mono(.footnote)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(6)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Fill.well, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
                .accessibilityElement(children: .combine)
            }
        case .plan:
            VStack(alignment: .leading, spacing: 12) {
                if let steps = request.plan?.steps, !steps.isEmpty {
                    PlanSteps(steps: steps)
                }
                if let text = PlanText.of(request), !text.isEmpty {
                    MarkdownView(text)
                }
            }
        case .questions(let questions):
            VStack(alignment: .leading, spacing: 10) {
                if let message = request.message, !message.isEmpty {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(questions, id: \.answerKey) { question in
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
}

/// A plan's text: the Mac's, else the request's own summary from a Mac that sends no plan.
enum PlanText {
    static func of(_ request: TranscriptRow.Request) -> String? {
        request.plan?.text ?? (request.summary.isEmpty ? nil : request.summary)
    }
}

/// The request a session waits on, in the composer's place where the next press is: who asks and
/// what, and the answers — Allow and Deny in place, questions and a plan in a sheet. Once answered it
/// says where the answer is until the Mac has it, and holds a Don't send while it waits. It is opaque:
/// a decision is read, and the transcript showing through it would be read too.
struct WaitingDock: View {
    let pending: PendingRequest
    let sessionId: String
    /// Folds it to one line, giving the composer back.
    let fold: () -> Void
    @Environment(AppModel.self) private var model
    @State private var answering = false
    @State private var reviewingPlan = false

    var body: some View {
        let request = pending.request
        let session = model.store.transcript(sessionId).session
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 6) {
                HStack(spacing: 6) {
                    AgentMark(kind: session?.agent ?? "", mark: session?.agentMark, colored: true, size: 14, relativeTo: .footnote)
                    Text("\(Asker.name(request, agent: session?.agent ?? "")) asks")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 8)
                Button(action: fold) {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                        .frame(width: 44, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, -6)
                .accessibilityLabel("Fold")
                .accessibilityHint("Shows the message field, with this request as one line above it")
            }
            Text(headline)
                .font(.headline)
                .foregroundStyle(Palette.ink)
                .lineLimit(3)
            if case .permission = request.kind, !request.summary.isEmpty, request.summary != request.tool {
                Text(request.summary)
                    .mono(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(2)
            }
            if let answer = pending.answer {
                held(answer)
            } else {
                actions
            }
        }
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
        .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
        .sheet(isPresented: $answering) {
            let stored = model.store.drafts[request.requestId]
            QuestionSheet(draft: stored ?? QuestionDefaults.applied(to: model.store.draft(for: request, in: sessionId)),
                          asker: Asker.name(request, agent: session?.agent ?? ""), message: request.message)
        }
        .sheet(isPresented: $reviewingPlan) {
            PlanSheet(request: request, sessionId: sessionId)
        }
        .accessibilityElement(children: .contain)
    }

    /// The one line that says what is asked.
    private var headline: String {
        switch pending.request.kind {
        case .permission: RequestCard.title(pending.request) ?? "A permission"
        case .plan:
            if let steps = pending.request.plan?.steps, !steps.isEmpty {
                "A plan to approve · \(steps.count) \(steps.count == 1 ? "step" : "steps")"
            } else {
                "A plan to approve"
            }
        case .questions(let questions):
            questions.count == 1 ? questions[0].question : "\(questions.count) questions · \(questions[0].question)"
        }
    }

    @ViewBuilder
    private var actions: some View {
        let request = pending.request
        switch request.kind {
        case .permission:
            AnswerButtons(decline: "Deny", accept: "Allow",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { model.answer(.allow, to: request, in: sessionId) })
        case .plan:
            AnswerButtons(decline: "Keep planning", accept: "Review the plan",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { reviewingPlan = true })
        case .questions:
            AnswerButtons(decline: "Skip", accept: model.store.drafts[request.requestId] == nil ? "Answer" : "Continue answering",
                          onDecline: { model.answer(.deny, to: request, in: sessionId) },
                          onAccept: { answering = true })
        }
    }

    /// The answer given and where it is: on its way, waiting for the Mac, or refused.
    private func held(_ item: OutgoingItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .answer(_, let decision, let answers) = item.payload {
                Text(RequestCard.describe(decision, answers: answers, kind: pending.request.kind))
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
}

/// A decline and an accept as two capsules sharing the width. Where both words do not fit on one line
/// — a long label, or the accessibility sizes — they stack, the accept first. The accept is the one
/// filled control, on the accent's fill; the decline is the neutral one.
struct AnswerButtons: View {
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
        .buttonStyle(GreyButtonStyle())
    }

    private var acceptButton: some View {
        Button(action: onAccept) {
            Text(accept)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(InkButtonStyle())
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

/// A fresh answer opens with what the asker suggests already picked, as the desktop's card opens.
enum QuestionDefaults {
    static func applied(to draft: AnswerDraft) -> AnswerDraft {
        var draft = draft
        for question in draft.questions {
            guard let suggested = question.defaultAnswer else { continue }
            let values: [String] = switch suggested {
            case .one(let value): [value]
            case .several(let values): values
            }
            for value in values {
                if let option = question.options.first(where: { $0.answerValue == value || $0.label == value }) {
                    if !draft.isPicked(option.label, in: question) { draft.toggle(option.label, in: question) }
                } else if question.takesText {
                    draft.setOther(value, for: question)
                }
            }
        }
        return draft
    }
}

/// What a question this iPhone cannot answer asks for, in the words that send the person to the Mac.
enum MacOnlyKind {
    static func words(_ kind: String?) -> String {
        switch kind {
        case "model": "It picks a model from the ones Realm on your Mac can run."
        case "file": "It picks a file from the checkout on your Mac."
        case "branch": "It picks a branch from the checkout on your Mac."
        case "time": "It picks a date and time."
        case "link": "It opens a page on your Mac."
        default: "Realm on your Mac answers this kind of question."
        }
    }
}

/// The questions, answered in a sheet: one section for each, saying who asks. Its picks are kept as
/// they are made; putting it away — Not now, or a swipe — sends nothing. Only Send answers.
struct QuestionSheet: View {
    @State var draft: AnswerDraft
    let asker: String
    var message: String?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var picks = 0

    var body: some View {
        NavigationStack {
            Form {
                if let message, !message.isEmpty {
                    Section {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(Palette.ink2)
                            .listRowBackground(Color.clear)
                    }
                }
                ForEach(draft.questions, id: \.answerKey) { question in
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
        // The sheet's own ground is Realm's too, so the part a keyboard leaves never shows the system's.
        .presentationBackground(Ground.grouped)
        .sensoryFeedback(.selection, trigger: picks)
        .onChange(of: draft) { _, changed in model.store.keepDraft(changed) }
    }
}

/// One question: its header, its words and the line under them at the section's head; its options as
/// rows that take a checkmark; and a field for an answer of the person's own where the asker takes
/// one. A kind this iPhone cannot answer says where it can be.
private struct QuestionSection: View {
    let question: Question
    @Binding var draft: AnswerDraft
    let picked: () -> Void
    @FocusState private var typing: Bool

    var body: some View {
        Section {
            if question.isAnswerableHere {
                ForEach(question.options, id: \.label) { option in
                    optionRow(option)
                }
                if question.takesText {
                    otherRow
                }
            } else {
                Label("Answer this one on your Mac", systemImage: "laptopcomputer")
                    .foregroundStyle(Palette.ink2)
                    .listRowBackground(Fill.card)
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
                if let detail = question.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .textCase(nil)
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        } footer: {
            if !question.isAnswerableHere {
                Text(MacOnlyKind.words(question.kind))
            } else if question.secret {
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
        let placeholder = question.placeholder ?? (question.options.isEmpty ? "Your answer" : "Other")
        return HStack(spacing: 12) {
            if question.secret {
                Image(systemName: "key.fill")
                    .foregroundStyle(Palette.ink3)
                    .accessibilityHidden(true)
                SecureField(placeholder, text: other)
                    .tint(Palette.accent)
                    .textContentType(.password)
                    .focused($typing)
                    .accessibilityLabel(fieldLabel)
            } else {
                TextField(placeholder, text: other, axis: .vertical)
                    .tint(Palette.accent)
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

/// A plan to approve, read whole: its steps and its text, then the two answers — implementing it,
/// which is how a session leaves planning, or planning on.
struct PlanSheet: View {
    let request: TranscriptRow.Request
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let steps = request.plan?.steps, !steps.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(PlanSteps.progress(steps))
                                .font(.footnote)
                                .foregroundStyle(Palette.ink2)
                            PlanSteps(steps: steps)
                        }
                        .padding(Radius.cardPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .surface()
                    }
                    if let text = PlanText.of(request), !text.isEmpty {
                        MarkdownView(text)
                    }
                }
                .padding(16)
            }
            .background(Ground.transcript)
            .navigationTitle("A plan to approve")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { dismiss() }
                }
            }
            .safeAreaBar(edge: .bottom) {
                AnswerButtons(decline: "Keep planning", accept: "Implement this plan",
                              onDecline: {
                                  model.answer(.deny, to: request, in: sessionId)
                                  dismiss()
                              },
                              onAccept: {
                                  model.answer(.allow, to: request, in: sessionId)
                                  dismiss()
                              })
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
    }
}

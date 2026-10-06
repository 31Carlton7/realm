import RealmKit
import SwiftUI

struct SessionView: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var sending = false

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        ScrollViewReader { proxy in
            List {
                if let problem = model.problem {
                    Label(problem, systemImage: "exclamationmark.triangle")
                }
                if transcript.hasMore {
                    Text("Earlier rows are on your Mac.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(transcript.rows) { row in
                    TranscriptRowView(row: row, sessionId: sessionId)
                        .id(row.key)
                }
            }
            .listStyle(.plain)
            .onChange(of: transcript.rows.last) { _, last in
                if let last { proxy.scrollTo(last.key, anchor: .bottom) }
            }
        }
        .navigationTitle(transcript.session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if transcript.status == .running {
                    Button("Stop", role: .destructive) {
                        Task { await model.stop(sessionId) }
                    }
                } else if let status = transcript.status {
                    Text(status.word)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .task(id: model.channelGeneration) { await model.open(sessionId) }
        .onDisappear {
            Task { await model.close(sessionId) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
            Button(sending ? "Sending…" : "Send") { send() }
                .buttonStyle(.borderedProminent)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || !model.isConnected)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        Task {
            if await model.send(text, to: sessionId) { draft = "" }
            sending = false
        }
    }
}

struct TranscriptRowView: View {
    let row: TranscriptRow
    let sessionId: String

    var body: some View {
        switch row.content {
        case .user(let text):
            VStack(alignment: .leading, spacing: 4) {
                Text("You")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(text)
            }
        case .assistant(let text, let streaming):
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.markdown(text))
                if streaming {
                    Text("Writing…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        case .thinking(let text):
            DisclosureGroup("Thinking") {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        case .tool(let name, let summary, let state, let detail):
            DisclosureGroup {
                Text(detail ?? "No output yet.")
                    .font(.caption.monospaced())
                    .foregroundStyle(detail == nil ? .secondary : .primary)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(name).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(Self.word(state)).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(summary)
                        .font(.caption.monospaced())
                        .lineLimit(2)
                }
            }
        case .request(let request):
            RequestView(request: request, sessionId: sessionId)
        case .plan(let text, let steps):
            VStack(alignment: .leading, spacing: 6) {
                Text("Plan").font(.subheadline.weight(.semibold))
                if let text { Text(Self.markdown(text)) }
                ForEach(Array((steps ?? []).enumerated()), id: \.offset) { _, step in
                    Text("\(step.status): \(step.text)")
                        .font(.callout)
                }
            }
        case .notice(let text):
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .error(let text, let hint):
            VStack(alignment: .leading, spacing: 4) {
                Label(text, systemImage: "exclamationmark.triangle")
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        case .unknown:
            Text("Open this on your Mac")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// Inline Markdown only, drawn as text: no HTML, no images.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }

    static func word(_ state: ToolState) -> String {
        switch state {
        case .running: "Running"
        case .done: "Done"
        case .error: "Failed"
        }
    }
}

/// A permission or a question the agent is blocked on, answered in place. Swiping away or leaving the
/// screen answers nothing.
struct RequestView: View {
    let request: TranscriptRow.Request
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var picks: [String: Set<String>] = [:]
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(request.title.isEmpty ? request.tool : request.title)
                .font(.subheadline.weight(.semibold))
            if !request.summary.isEmpty, request.summary != request.tool {
                Text(request.summary)
                    .font(.callout)
            }
            switch request.state {
            case .pending:
                if let questions = request.questions, !questions.isEmpty {
                    questionForm(questions)
                } else {
                    HStack {
                        Button("Allow") { answer(.allow) }
                            .buttonStyle(.borderedProminent)
                        Button("Deny", role: .destructive) { answer(.deny) }
                            .buttonStyle(.bordered)
                    }
                    .disabled(busy)
                }
            case .allowed:
                Text("Allowed").foregroundStyle(.secondary)
            case .denied:
                Text("Denied").foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func questionForm(_ questions: [Question]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(questions, id: \.question) { question in
                VStack(alignment: .leading, spacing: 6) {
                    if !question.header.isEmpty {
                        Text(question.header)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(question.question)
                    if question.multiSelect {
                        Text("Choose any that apply.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(question.options, id: \.label) { option in
                        optionButton(option, of: question)
                    }
                    if question.options.isEmpty {
                        Text("Answer this one on your Mac.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Button("Send answers") {
                    answer(.allow, answers: Question.answers(questions, picks: picks))
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isComplete(questions))
                Button("Skip", role: .destructive) { answer(.deny) }
                    .buttonStyle(.bordered)
            }
            .disabled(busy)
        }
    }

    private func optionButton(_ option: QuestionOption, of question: Question) -> some View {
        let chosen = picks[question.question]?.contains(option.label) == true
        let symbol = question.multiSelect
            ? (chosen ? "checkmark.square.fill" : "square")
            : (chosen ? "largecircle.fill.circle" : "circle")
        return Button {
            toggle(option.label, in: question)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                    if let description = option.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        }
        .buttonStyle(.bordered)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private func toggle(_ label: String, in question: Question) {
        var chosen = picks[question.question] ?? []
        if question.multiSelect {
            if chosen.contains(label) { chosen.remove(label) } else { chosen.insert(label) }
        } else {
            chosen = [label]
        }
        picks[question.question] = chosen
    }

    /// Every question that offers options has one picked.
    private func isComplete(_ questions: [Question]) -> Bool {
        questions.allSatisfy { $0.options.isEmpty || picks[$0.question]?.isEmpty == false }
            && questions.contains { !$0.options.isEmpty }
    }

    private func answer(_ decision: Decision, answers: [String: String]? = nil) {
        busy = true
        Task {
            _ = await model.answer(sessionId, requestId: request.requestId, decision: decision, answers: answers)
            busy = false
        }
    }
}

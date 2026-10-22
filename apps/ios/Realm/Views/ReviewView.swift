import QuickLook
import RealmKit
import SwiftUI
import UIKit

/// Where a review stands, as far as the phone acts on it: waiting for the person's decision, sent back
/// for a new version, approved with something still to press on the Mac, or decided and done with.
enum ReviewStage: Equatable {
    /// Approve, Ask for changes and Reject are offered.
    case waiting
    /// The person asked for changes, and the role has not sent a new version yet.
    case changes
    /// Approved, and not finished with: what goes out is pressed on the Mac.
    case approved
    case decided(String)

    init(_ state: String) {
        switch state.lowercased() {
        case "open", "waiting": self = .waiting
        case "changes": self = .changes
        case "approved": self = .approved
        default: self = .decided(state)
        }
    }

    /// What a review that does not wait for the person says of itself; nil for one that does.
    var words: String? {
        switch self {
        case .waiting: nil
        case .changes: "Changes asked for · waiting for a new version"
        case .approved: "Approved · finish it on your Mac"
        case .decided(let state): state.prefix(1).uppercased() + state.dropFirst()
        }
    }
}

/// The open reviews, newest first; two that moved at the same moment keep the Mac's order.
enum ReviewOrder {
    static func newestFirst(_ reviews: [ReviewSummary]) -> [ReviewSummary] {
        reviews.stablySorted { $0.updatedAt > $1.updatedAt }
    }
}

/// Teams' Review in words: who handed a review back and where it goes, what Approve does before it is
/// pressed, and what a decision left.
enum ReviewWords {
    /// Whether what a review asks to send is posted or sent, as its kind says, or neither.
    enum Family {
        case post, send
    }

    static func family(_ review: ReviewSummary) -> Family? {
        switch review.kind.lowercased() {
        case "post", "posts", "slideshows", "slideshow": .post
        case "message", "messages", "email", "dm", "reply": .send
        default: nil
        }
    }

    /// "Writer · Launch": the role that handed it back, then its space.
    static func about(_ review: ReviewSummary) -> String {
        [review.roleName, review.spaceName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// "To @reader on Instagram · 2 items": who it goes to, or where, and how many items it holds.
    static func reach(_ review: ReviewSummary) -> String {
        let channels = review.channels.filter { !$0.isEmpty && !["email", "e-mail", "mail"].contains($0.lowercased()) }.map(channel)
        var parts: [String] = []
        if let to = review.to, !to.isEmpty {
            parts.append("To \(to)" + (channels.first.map { " on \($0)" } ?? ""))
        } else if !channels.isEmpty {
            parts.append("On " + channels.formatted(.list(type: .and)))
        }
        parts.append(items(review.itemCount))
        return parts.joined(separator: " · ")
    }

    /// "1 item", "3 items"
    static func items(_ count: Int) -> String {
        count == 1 ? "1 item" : "\(count) items"
    }

    /// One item's place and where it goes: "Item 2 of 3 · Instagram · to @reader".
    static func item(_ item: ReviewDetail.Item, at index: Int, of count: Int) -> String {
        let place = count > 1 ? ["Item \(index + 1) of \(count)"] : []
        let channel = item.channel.flatMap { $0.isEmpty ? nil : channel($0) }
        let to = item.to.flatMap { $0.isEmpty ? nil : "to \($0)" }
        return (place + [channel, to].compactMap { $0 }).joined(separator: " · ")
    }

    /// A channel as the place it names: "instagram" from a connector reads as the platform does.
    static func channel(_ name: String) -> String {
        name == name.lowercased() ? name.prefix(1).uppercased() + name.dropFirst() : name
    }

    /// Said beside Approve, before it is pressed: approving sends nothing by itself.
    static func approving(_ review: ReviewSummary) -> String {
        switch family(review) {
        case .post: "Approving posts nothing by itself: you still press Post on your Mac."
        case .send: "Approving sends nothing by itself: you still press Send on your Mac."
        case nil: "Approving sends nothing by itself: anything that goes out is still pressed on your Mac."
        }
    }

    /// Who a note goes to: the role, by name.
    static func role(_ review: ReviewSummary) -> String {
        review.roleName.flatMap { $0.isEmpty ? nil : $0 } ?? "the role"
    }

    /// What a decision left, said once it is in.
    static func receipt(_ decision: ReviewDecision, _ review: ReviewSummary) -> String {
        switch decision {
        case .approve:
            switch family(review) {
            case .post: "Approved. It posts when you press Post on your Mac."
            case .send: "Approved. It sends when you press Send on your Mac."
            case nil: "Approved. Nothing goes out until it is pressed on your Mac."
            }
        case .changes: "Asked \(role(review)) for changes."
        case .reject: "Rejected. Nothing of it goes out."
        }
    }

    /// A row as VoiceOver reads it: the title, then everything the row shows, in words.
    static func spoken(_ review: ReviewSummary, now: Date = Date()) -> String {
        ([review.title, about(review), reach(review)] + [ReviewStage(review.state).words].compactMap { $0 }
            + [Ago.text(review.updatedAt, now: now)]).joined(separator: ", ")
    }
}

/// The note a decision carries: asking for changes says what should change, and must; a rejection may
/// say why.
struct DecisionNote: Equatable {
    let decision: ReviewDecision
    let title: String
    let prompt: String
    let footer: String
    let confirm: String

    init(_ decision: ReviewDecision, for review: ReviewSummary) {
        self.decision = decision
        let role = ReviewWords.role(review)
        switch decision {
        case .reject:
            title = "Reject"
            prompt = "Why not? (optional)"
            footer = "Nothing of it goes out, and it can't be sent again."
            confirm = "Reject"
        case .changes, .approve:
            title = "Ask for changes"
            prompt = "What should \(role) change?"
            footer = "Your note goes to \(role). Nothing of the draft goes out."
            confirm = "Send"
        }
    }

    /// The note as it goes, trimmed; nil for none, which only a rejection may send.
    func note(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func canSend(_ text: String) -> Bool {
        decision != .changes || note(text) != nil
    }
}

extension ReviewDecision: @retroactive Identifiable {
    public var id: Self { self }
}

/// What teams have handed back for the person to approve and is still open, newest first: who handed
/// it back and where, what it is, who it goes to and how many items it holds. Read again whenever the
/// Mac says Review changed, and when pulled.
struct ReviewsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let reviews = model.work.reviews
        List {
            ForEach(reviews ?? []) { review in
                NavigationLink(value: Route.review(review.id)) {
                    ReviewRow(review: review)
                }
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(Palette.divider)
                .accessibilityIdentifier("review-\(review.id)")
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .overlay {
            if let reviews, reviews.isEmpty {
                ContentUnavailableView("Nothing to review", systemImage: "tray",
                                       description: Text("When a team hands something back for you to approve, it shows here."))
            } else if reviews == nil {
                Unreached(what: "Review", working: model.isConnected && !model.work.unsupported)
            }
        }
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.channelGeneration) { await model.work.refresh() }
        .refreshable { await model.work.refresh() }
    }
}

/// One open review, as an inbox's line: the role and the space with its age, the title, then what it is
/// and where it goes.
private struct ReviewRow: View {
    let review: ReviewSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ReviewWords.about(review))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(Ago.text(review.updatedAt, now: context.date))
                        .monospacedDigit()
                        .fixedSize()
                }
            }
            .font(.footnote)
            .foregroundStyle(Palette.ink2)
            Text(review.title)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
            Text(ReviewWords.reach(review))
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
            if let words = ReviewStage(review.state).words {
                Text(words)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink2)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ReviewWords.spoken(review))
        .accessibilityHint("Opens the review")
    }
}

/// One review: each item's draft as it would go out, where it goes, and its pictures, which open in
/// Quick Look; at the foot, the decision. Read again when the Mac says Review changed.
struct ReviewView: View {
    let reviewId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: ReviewDetail?
    @State private var problem: String?
    @State private var asking: ReviewDecision?
    @State private var deciding = false

    /// What reads the review again: its row on a new listing, and a new channel to the Mac.
    private struct Reading: Hashable {
        let listed: ReviewSummary?
        let generation: Int
    }

    var body: some View {
        let listed = model.work.reviews?.first { $0.id == reviewId }
        let review = detail?.review ?? listed
        ScrollView {
            if let detail {
                ReviewDrafts(detail: detail)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        }
        .background(Ground.transcript)
        .overlay {
            if detail == nil {
                if let problem {
                    ContentUnavailableView("The review did not load", systemImage: "exclamationmark.triangle", description: Text(problem))
                } else {
                    Unreached(what: "This review", working: model.isConnected)
                }
            }
        }
        .safeAreaBar(edge: .bottom) {
            if let review = detail?.review, ReviewStage(review.state) == .waiting {
                DecisionDock(review: review, deciding: deciding) { decision in
                    if decision == .approve {
                        Task { await decide(.approve, note: nil) }
                    } else {
                        asking = decision
                    }
                }
            }
        }
        .navigationTitle(review?.title ?? "Review")
        .navigationSubtitle(review.map(ReviewWords.about) ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: Reading(listed: listed, generation: model.channelGeneration)) { await load() }
        .sheet(item: $asking) { decision in
            if let review {
                DecisionNoteSheet(note: DecisionNote(decision, for: review)) { text in
                    await decide(decision, note: text)
                }
            }
        }
    }

    private func load() async {
        do {
            detail = try await model.work.review(reviewId)
            problem = nil
        } catch is CancellationError {
            // Read again by the change that cancelled it.
        } catch {
            if detail == nil { problem = AppModel.describe(error) }
        }
    }

    /// Sends a decision. In, it is said in a toast and the page goes back to the list it came from;
    /// refused, the toast says why and the page stays. Whether it went, for the note's sheet.
    @discardableResult
    private func decide(_ decision: ReviewDecision, note: String?) async -> Bool {
        guard let review = detail?.review, !deciding else { return false }
        deciding = true
        defer { deciding = false }
        do {
            let decided = try await model.work.decide(review.id, decision, note: note)
            model.show(toast: ReviewWords.receipt(decision, decided))
            asking = nil
            dismiss()
            return true
        } catch {
            model.show(toast: "\(DecisionWords.failed(decision)) \(AppModel.describe(error))")
            return false
        }
    }
}

/// What a decision that did not go says first.
private enum DecisionWords {
    static func failed(_ decision: ReviewDecision) -> String {
        switch decision {
        case .approve: "Not approved."
        case .changes: "Changes not asked for."
        case .reject: "Not rejected."
        }
    }
}

/// The review's drafts: what it is and where it goes, the person's last note where they asked for
/// changes before, then each item.
private struct ReviewDrafts: View {
    let detail: ReviewDetail

    var body: some View {
        let review = detail.review
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(ReviewWords.reach(review))
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                if let words = ReviewStage(review.state).words {
                    Text(words)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                }
            }
            if let note = review.note, !note.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your last note")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Radius.cardPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .surface()
            }
            ForEach(Array(detail.items.enumerated()), id: \.element.id) { index, item in
                ReviewItemView(item: item, place: ReviewWords.item(item, at: index, of: detail.items.count), reviewId: review.id)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One item: its title and place, its draft as Markdown on a card, and its pictures under it.
private struct ReviewItemView: View {
    let item: ReviewDetail.Item
    let place: String
    let reviewId: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = item.title, !title.isEmpty {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
            }
            if !place.isEmpty {
                Text(place)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            VStack(alignment: .leading, spacing: 14) {
                if !item.body.isEmpty {
                    MarkdownView(item.body)
                        .environment(\.proseGround, .card)
                }
                if !item.files.isEmpty {
                    ReviewPictures(files: item.files, reviewId: reviewId)
                }
            }
            .padding(Radius.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .surface()
        }
    }
}

/// An item's pictures as tiles, each the Mac's small copy, opening in Quick Look, where the others can
/// be swiped to. A file that is not a picture is named, and opens on the Mac.
private struct ReviewPictures: View {
    let files: [SentFile]
    let reviewId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 96
    @State private var pictures: [String: Picture] = [:]
    @State private var previewing: URL?

    /// A picture as it came: small enough for its tile, and kept under its own name for Quick Look.
    private struct Picture {
        let thumbnail: UIImage
        let file: URL
    }

    var body: some View {
        let images = files.filter(\.isImage)
        VStack(alignment: .leading, spacing: 8) {
            if !images.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(images) { file in
                            Button {
                                previewing = pictures[file.path]?.file
                            } label: {
                                tile(file)
                            }
                            .buttonStyle(.plain)
                            .disabled(pictures[file.path] == nil)
                            .accessibilityLabel(file.name)
                            .accessibilityHint("Opens it in Quick Look")
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .scrollClipDisabled()
            }
            ForEach(files.filter { !$0.isImage }) { file in
                Label(file.name, systemImage: FileKind.symbol(file.name))
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .quickLookPreview($previewing, in: images.compactMap { pictures[$0.path]?.file })
        .task(id: reviewId) { await load(images) }
    }

    private func tile(_ file: SentFile) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous)
                .fill(Fill.well)
            if let picture = pictures[file.path] {
                Image(uiImage: picture.thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: side, height: side)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous)
                            .strokeBorder(Palette.line, lineWidth: 1 / displayScale)
                    }
                    .transition(.opacity)
            } else {
                ProgressView()
            }
        }
        .frame(width: side, height: side)
        .animation(.easeOut(duration: 0.2), value: pictures[file.path] != nil)
    }

    /// Each picture, asked of the Mac in turn and written where Quick Look opens it, titled with its
    /// own name.
    private func load(_ images: [SentFile]) async {
        let folder = URL.temporaryDirectory.appending(path: "Review/\(reviewId)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for file in images where pictures[file.path] == nil {
            guard let preview = try? await model.work.picture(file.path, of: reviewId),
                  case .image(_, let data) = preview.preview, let image = UIImage(data: data) else { continue }
            let url = folder.appending(path: file.name.replacingOccurrences(of: "/", with: "-"))
            try? data.write(to: url)
            let size = CGSize(width: side * displayScale, height: side * displayScale)
            pictures[file.path] = Picture(thumbnail: await image.byPreparingThumbnail(ofSize: size) ?? image, file: url)
        }
    }
}

/// The decision, docked at the foot where it stays in reach as the drafts scroll: what Approve does,
/// said before it is pressed, then Approve, and beside each other the two that send words back.
private struct DecisionDock: View {
    let review: ReviewSummary
    let deciding: Bool
    let choose: (ReviewDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(ReviewWords.approving(review))
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                choose(.approve)
            } label: {
                HStack(spacing: 6) {
                    if deciding { ProgressView().controlSize(.small).tint(.white) }
                    Text(review.itemCount > 1 ? "Approve all \(review.itemCount)" : "Approve")
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Palette.accentFill)
            ViewThatFits(in: .horizontal) {
                EqualWidths(spacing: 10) {
                    secondary
                }
                VStack(spacing: 10) {
                    secondary
                }
            }
        }
        .controlSize(.large)
        .buttonBorderShape(.capsule)
        .font(.body.weight(.semibold))
        .disabled(deciding)
        .padding(Radius.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
        .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var secondary: some View {
        Button {
            choose(.changes)
        } label: {
            Text("Ask for changes")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(Palette.ink)
        Button {
            choose(.reject)
        } label: {
            Text("Reject")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(Palette.red)
    }
}

/// The note for Ask for changes, which needs one, or Reject, which may have one. Cancel sends nothing;
/// the sheet stays until the Mac has the decision, and says why where it refuses.
private struct DecisionNoteSheet: View {
    let note: DecisionNote
    let send: (String?) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(note.prompt, text: $text, axis: .vertical)
                        .lineLimit(3...10)
                        .focused($focused)
                        .listRowBackground(Fill.card)
                } footer: {
                    Text(note.footer)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .navigationTitle(note.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            sending = true
                            if await send(note.note(text)) { dismiss() }
                            sending = false
                        }
                    } label: {
                        if sending { ProgressView() } else { Text(note.confirm) }
                    }
                    .tint(note.decision == .reject ? Palette.red : nil)
                    .disabled(sending || !note.canSend(text))
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .interactiveDismissDisabled(sending)
        .onAppear { focused = true }
    }
}

/// Before the Mac has answered for a page: on its way, or why it cannot come.
struct Unreached: View {
    /// What the page shows, as the start of a sentence: "Review", "This review".
    let what: String
    /// The Mac is there to ask, so the answer is on its way.
    let working: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        if working {
            ProgressView()
        } else {
            ContentUnavailableView {
                Label("\(what) is on your Mac", systemImage: "laptopcomputer")
            } description: {
                Text(model.work.unsupported ? "Update Realm on your Mac to see it here." : "This iPhone shows it while your Mac is connected.")
            }
        }
    }
}

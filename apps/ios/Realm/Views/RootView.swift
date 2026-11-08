import RealmKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.store.pairedMac == nil {
                NavigationStack {
                    PairView()
                }
            } else {
                NavigationStack(path: $model.path) {
                    HomeView()
                        .navigationDestination(for: Route.self) { route in
                            Group {
                                switch route {
                                case .session(let id): SessionView(sessionId: id)
                                case .space(let id): SpaceView(spaceId: id)
                                case .reviews: ReviewsView()
                                case .review(let id): ReviewView(reviewId: id)
                                case .scheduled: ScheduledView()
                                case .usage: UsageView()
                                case .saved: SavedView()
                                case .team: TeamView()
                                case .documents(let spaceId, let dir): FolderView(spaceId: spaceId, dir: dir)
                                case .library: LibraryView()
                                case .libraryFiles(let shelf): LibraryShelfView(shelf: shelf)
                                case .document(let ref): DocumentReader(document: ref)
                                case .memory: MemoryView()
                                case .memoryPlace(let place): MemoryPlaceView(place: place)
                                case .memoryFile(let ref): MemoryFileView(memory: ref)
                                }
                            }
                            .backOnGround()
                        }
                }
                .renameAlert()
                .sessionActionSheets()
                // A lead's sub-agents, from its row's press-and-hold.
                .sheet(item: subagentsLead) { lead in
                    SubagentsSheet(sessionId: lead.id)
                }
                // A teammate's Edit sheet, from its row or its chat's menu.
                .sheet(item: teammateEditing) { shown in
                    TeammateSheet(teammateId: shown.id)
                }
                // New teammate, from the Team's "+".
                .sheet(item: newTeammateSpace) { shown in
                    NewTeammateSheet(spaces: teamSpaces, spaceId: shown.id, agents: model.agentList)
                        .presentationDetents([.large])
                }
                // A link opened while a Mac is paired pairs over the top of it.
                .sheet(isPresented: pairingOverTheTop) {
                    NavigationStack { PairView(overTheTop: true) }
                }
            }
        }
        // Chrome is monochrome, as iOS draws its own bars: a bar's glyphs and a menu's icons in ink, and
        // the accent kept for what it means — a selection, a link, a switch that is on, the one primary
        // action, the caret — each of which asks for it where it is drawn.
        .tint(Palette.ink)
        .overlay(alignment: .top) { ToastView() }
        .confirmationDialog(replaceTitle, isPresented: replacing, titleVisibility: .visible) {
            Button("Pair") {
                let link = model.replacingPairLink
                model.replacingPairLink = nil
                if let link { Task { await model.pair(with: link) } }
            }
            Button("Cancel", role: .cancel) { model.replacingPairLink = nil }
        } message: {
            Text("This iPhone will stop showing \(model.store.pairedMac?.macName ?? "this Mac")'s sessions.")
        }
    }

    private var subagentsLead: Binding<ShownLead?> {
        Binding(get: { model.subagentsShown.map(ShownLead.init) }, set: { model.subagentsShown = $0?.id })
    }

    private var teammateEditing: Binding<ShownLead?> {
        Binding(get: { model.teammateEditing.map(ShownLead.init) }, set: { model.teammateEditing = $0?.id })
    }

    private var newTeammateSpace: Binding<ShownLead?> {
        Binding(get: { model.newTeammateSpace.map(ShownLead.init) }, set: { model.newTeammateSpace = $0?.id })
    }

    /// The spaces a new teammate can join: those of the profile Home shows.
    private var teamSpaces: [Space] {
        (model.store.home?.spaces ?? []).filter(model.profileChoice.includes)
    }

    private var pairingOverTheTop: Binding<Bool> {
        Binding(get: { model.pairing != .idle || model.pairingRequested }, set: { shown in
            guard !shown else { return }
            model.pairingRequested = false
            if !model.pairing.isBusy { model.pairing = .idle }
        })
    }

    private var replacing: Binding<Bool> {
        Binding(get: { model.replacingPairLink != nil }, set: { if !$0 { model.replacingPairLink = nil } })
    }

    private var replaceTitle: String {
        let name = model.replacingPairLink.flatMap { try? PairingLink.decode($0) }?.macName ?? "another Mac"
        return "Pair with \(name)?"
    }
}

/// Something that happened, at the top of the screen for a few seconds on a card lifted over the
/// reading, as the composer is: it never covers the composer, and leaves on its own. One that can be
/// taken back says Undo beside its words, and stays twice as long: it is an offer still open.
struct ToastView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let toast = model.toast {
            HStack(spacing: 16) {
                Text(toast.text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(toast.undo == nil ? .center : .leading)
                    .accessibilityAddTraits(.isStaticText)
                if let undo = toast.undo {
                    Button("Undo") {
                        model.toast = nil
                        undo()
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.accentInk)
                    .touchTarget()
                }
            }
            .padding(.horizontal, 18)
            // Undo's own 44 points stand in for the height the words are padded to.
            .padding(.vertical, toast.undo == nil ? 12 : 0)
            .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
            .floatingLift()
            .padding(.horizontal, 24)
            .padding(.top, 8)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            .task(id: toast.id) {
                UIAccessibility.post(notification: .announcement, argument: toast.text)
                try? await Task.sleep(for: .seconds(toast.undo == nil ? 4 : 8))
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    if model.toast?.id == toast.id { model.toast = nil }
                }
            }
            .onTapGesture { model.toast = nil }
        }
    }
}

/// The lead a sub-agents sheet is up for.
private struct ShownLead: Identifiable {
    let id: String
}

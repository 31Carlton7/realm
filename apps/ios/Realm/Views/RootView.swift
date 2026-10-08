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
                            switch route {
                            case .session(let id): SessionView(sessionId: id)
                            case .settings: SettingsView()
                            case .diagnostics: DiagnosticsView()
                            case .licences: LicencesView()
                            }
                        }
                }
                // A link opened while a Mac is paired pairs over the top of it.
                .sheet(isPresented: pairingOverTheTop) {
                    NavigationStack { PairView() }
                }
            }
        }
        .tint(Palette.accent)
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

    private var pairingOverTheTop: Binding<Bool> {
        Binding(get: { model.pairing != .idle }, set: { shown in if !shown, !model.pairing.isBusy { model.pairing = .idle } })
    }

    private var replacing: Binding<Bool> {
        Binding(get: { model.replacingPairLink != nil }, set: { if !$0 { model.replacingPairLink = nil } })
    }

    private var replaceTitle: String {
        let name = model.replacingPairLink.flatMap { try? PairingLink.decode($0) }?.macName ?? "another Mac"
        return "Pair with \(name)?"
    }
}

/// Something that happened, at the top of the screen for a few seconds: it never covers the
/// composer, and leaves on its own.
struct ToastView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let toast = model.toast {
            Text(toast.text)
                .inter(.subheadline, .label)
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .surface(Palette.surface, radius: Radius.panel)
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
                .task(id: toast.id) {
                    UIAccessibility.post(notification: .announcement, argument: toast.text)
                    try? await Task.sleep(for: .seconds(4))
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                        if model.toast?.id == toast.id { model.toast = nil }
                    }
                }
                .onTapGesture { model.toast = nil }
        }
    }
}

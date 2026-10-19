import SwiftUI

/// Motion: a critically damped spring for whatever arrives or changes, and nothing at all under
/// Reduce Motion, where the change simply lands.
enum Motion {
    static let spring = Animation.smooth(duration: 0.35)

    static func animation(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : spring
    }

    /// A row that arrived this long ago or less moves into place; older ones are simply there.
    static let freshFor: TimeInterval = 3
}

extension View {
    /// A label that says work is going on: a highlight crosses it a few times, then it holds still in
    /// its quiet ink, which says the same thing (design.md ▸ Motion). Never under Reduce Motion.
    func shimmer(when active: Bool) -> some View {
        modifier(Shimmer(active: active))
    }

    /// A row born a moment ago rises into place; one that was already there when the screen opened,
    /// or that scrolls back into view later, does not.
    func freshEntrance(born: Date?) -> some View {
        modifier(FreshEntrance(born: born))
    }
}

private struct Shimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweep: CGFloat = -1
    @State private var passes = 0

    /// How many times the highlight crosses before the label rests.
    static let passesBeforeRest = 3

    func body(content: Content) -> some View {
        content
            .overlay {
                if active && !reduceMotion && passes < Self.passesBeforeRest {
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width * 0.6)
                            .offset(x: sweep * geometry.size.width)
                            .blendMode(.plusLighter)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
            .task(id: active) {
                guard active, !reduceMotion else { return }
                passes = 0
                while passes < Self.passesBeforeRest, !Task.isCancelled {
                    sweep = -0.6
                    withAnimation(.easeInOut(duration: 1.35)) { sweep = 1 }
                    try? await Task.sleep(for: .seconds(2.8))
                    passes += 1
                }
            }
    }
}

private struct FreshEntrance: ViewModifier {
    let born: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        let fresh = !reduceMotion && (born.map { Date().timeIntervalSince($0) < Motion.freshFor } ?? false)
        content
            .opacity(fresh && !shown ? 0 : 1)
            .offset(y: fresh && !shown ? 8 : 0)
            .onAppear { if fresh { withAnimation(.easeOut(duration: 0.22)) { shown = true } } }
    }
}

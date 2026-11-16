import SwiftUI

/// What a page or a sheet shows when it has nothing to show, as the Mac's `EmptyState` draws it: a
/// glyph, a title in ink, one line in the secondary ink, and at most one action. Not
/// `ContentUnavailableView`: its line is the system grey, 3.3:1 on the light grouped ground.
struct EmptyState<Actions: View>: View {
    let title: String
    let systemImage: String
    let description: String?
    let actions: Actions

    init(_ title: String, systemImage: String, description: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.title = title
        self.systemImage = systemImage
        self.description = description
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.title)
                .foregroundStyle(Palette.ink3)
                .padding(.bottom, 6)
                .accessibilityHidden(true)
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            if let description {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
            }
            actions
                .padding(.top, 12)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: 440)
        .padding(.horizontal, 24)
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension EmptyState where Actions == EmptyView {
    init(_ title: String, systemImage: String, description: String? = nil) {
        self.init(title, systemImage: systemImage, description: description) { EmptyView() }
    }
}

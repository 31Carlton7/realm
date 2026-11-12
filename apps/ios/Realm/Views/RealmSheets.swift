import SwiftUI

// A question or a small input on Realm's own ground rather than the system's glass: iOS 26 draws
// `.confirmationDialog` and `.alert` as a translucent slab, a light grey one over the dark face.
// `scripts/chrome.test.ts` keeps both out of the app.

/// A step's question: its title and what it does, the step's own button beside Cancel — in ink, or in
/// the danger fill where the step deletes or removes something.
struct ConfirmSheet: View {
    let title: String
    let message: String
    let button: String
    var role: ButtonRole?
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetHead(title: title, message: message)
            HStack(spacing: 10) {
                Button("Cancel") { dismiss() }
                    .buttonStyle(GreyButtonStyle())
                Group {
                    if role == .destructive {
                        Button(button, role: .destructive, action: confirm)
                            .buttonStyle(DangerButtonStyle())
                    } else {
                        Button(button, action: confirm)
                            .buttonStyle(InkButtonStyle())
                    }
                }
                .accessibilityIdentifier("confirm")
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.top, 10)
        }
        .fittedSheet()
    }
}

/// A question with a few answers, each a full-width button, and Cancel under them.
struct ChoiceSheet: View {
    struct Choice: Identifiable {
        let title: String
        let pick: () -> Void
        var id: String { title }
    }

    let title: String
    let choices: [Choice]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetHead(title: title, message: nil)
            VStack(spacing: 10) {
                ForEach(choices) { choice in
                    Button(action: choice.pick) { Text(choice.title).frame(maxWidth: .infinity) }
                }
                Button { dismiss() } label: { Text("Cancel").frame(maxWidth: .infinity) }
            }
            .buttonStyle(GreyButtonStyle())
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
        }
        .fittedSheet()
    }
}

/// A name to change: the title, one field holding the name with the keyboard up, Cancel and Save.
/// Save stays off until the field says something new; return saves too.
struct RenameSheet: View {
    let title: String
    @Binding var name: String
    let canSave: Bool
    let save: () -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SheetHead(title: title, message: nil)
            TextField("Title", text: $name)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { if canSave { save() } }
                .foregroundStyle(Palette.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .accessibilityIdentifier("rename-field")
            HStack(spacing: 10) {
                Button("Cancel") { dismiss() }
                    .buttonStyle(GreyButtonStyle())
                Button("Save", action: save)
                    .buttonStyle(InkButtonStyle())
                    .disabled(!canSave)
                    .accessibilityIdentifier("rename-save")
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.top, 10)
        }
        .fittedSheet()
        .onAppear { focused = true }
    }
}

private struct SheetHead: View {
    let title: String
    let message: String?

    var body: some View {
        Text(title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(Palette.ink)
        if let message {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct FittedSheet: ViewModifier {
    @State private var height: CGFloat = 280

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 24)
            .padding(.top, 28)
            .padding(.bottom, 12)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .presentationDetents([.height(height)])
            .presentationBackground(Ground.grouped)
    }
}

private extension View {
    /// The small sheet's frame: its margins, as tall as what it holds, on the grouped ground.
    func fittedSheet() -> some View {
        modifier(FittedSheet())
    }
}

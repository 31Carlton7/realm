import AVKit
import QuickLook
import QuickLookThumbnailing
import RealmKit
import SwiftUI
import UIKit

/// What the gallery does with a file: a picture to zoom, a video to play, or a document for Quick Look.
enum GalleryKind: Equatable {
    case picture, video, document

    init(mime: String) {
        if mime.hasPrefix("image/") {
            self = .picture
        } else if mime.hasPrefix("video/") {
            self = .video
        } else {
            self = .document
        }
    }
}

/// A message's files in the order its row draws them, pictures first, and where in them the gallery is.
struct GalleryPages {
    let files: [SentFile]

    init(_ files: [SentFile]) {
        self.files = files.filter(\.isImage) + files.filter { !$0.isImage }
    }

    /// The page a tapped file opens on; the first for a file the message does not have.
    func page(of file: SentFile) -> Int {
        files.firstIndex(of: file) ?? 0
    }

    /// "2 of 5", or nothing for a message with one file.
    func position(_ page: Int) -> String {
        files.count > 1 ? "\(page + 1) of \(files.count)" : ""
    }

    /// A swipe on a message's files that opens the gallery: rightwards, mostly level, and far enough not
    /// to be a scroll that wandered.
    static func opens(_ swipe: CGSize) -> Bool {
        swipe.width > 60 && swipe.width > abs(swipe.height) * 2
    }
}

/// A swipe right across a message's files. iOS 26 goes back from a swipe right anywhere on the screen,
/// and a SwiftUI drag loses that race, so this is UIKit's pan with the navigation controller's back
/// swipes made to wait for it. It only begins for a rightward, mostly level drag: anything else is left
/// to the transcript's scroll and to going back.
struct GallerySwipe: UIGestureRecognizerRepresentable {
    let open: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        guard pan.state == .ended else { return }
        let swipe = pan.translation(in: pan.view)
        if GalleryPages.opens(CGSize(width: swipe.x, height: swipe.y)) { open() }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return velocity.x > 0 && velocity.x > abs(velocity.y) * 2
        }

        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            var responder: UIResponder? = gesture.view
            while let next = responder, !(next is UINavigationController) { responder = next.next }
            guard let navigation = responder as? UINavigationController else { return false }
            return other === navigation.interactiveContentPopGestureRecognizer || other === navigation.interactivePopGestureRecognizer
        }
    }
}

/// Where the gallery opens.
struct GalleryOpening: Identifiable {
    let page: Int
    var id: Int { page }
}

/// Every file a message took, full screen: one at a time to swipe between, or all of them as tiles.
/// Each file is fetched whole from the Mac when it is shown, so it can be zoomed, played, opened in
/// Quick Look, and shared or saved.
struct AttachmentGallery: View {
    let pages: GalleryPages
    let sessionId: String
    @State var page: Int
    @State private var showsAll = false
    /// The files fetched whole so far, by path: what Share hands on.
    @State private var fetched: [String: URL] = [:]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let file = pages.files[page]
        NavigationStack {
            ZStack {
                if showsAll {
                    GalleryGrid(pages: pages, sessionId: sessionId, page: page) { picked in
                        page = picked
                        withAnimation(Motion.morph) { showsAll = false }
                    }
                    .transition(.opacity)
                } else {
                    TabView(selection: $page) {
                        ForEach(pages.files.indices, id: \.self) { index in
                            GalleryPage(file: pages.files[index], sessionId: sessionId, isCurrent: index == page) { url in
                                fetched[pages.files[index].path] = url
                            }
                            .tag(index)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .transition(.opacity)
                }
            }
            .background(Ground.transcript)
            .navigationTitle(showsAll ? "\(pages.files.count) files" : file.name)
            .navigationSubtitle(showsAll ? "" : pages.position(page))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if pages.files.count > 1 {
                        Button(showsAll ? "Show one" : "Show all", systemImage: showsAll ? "rectangle" : "square.grid.2x2") {
                            withAnimation(Motion.morph) { showsAll.toggle() }
                        }
                    }
                    if !showsAll {
                        if let url = fetched[file.path] {
                            ShareLink(item: url) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        } else {
                            Button("Share", systemImage: "square.and.arrow.up") {}
                                .disabled(true)
                        }
                    }
                }
            }
        }
    }
}

/// One file of the gallery: its preview at once where it is a picture, then the file itself.
private struct GalleryPage: View {
    let file: SentFile
    let sessionId: String
    let isCurrent: Bool
    let fetched: (URL) -> Void
    @Environment(AppModel.self) private var model
    @State private var whole: URL?
    @State private var picture: UIImage?
    @State private var player: AVPlayer?
    @State private var progress = 0.0
    @State private var problem: String?

    private var kind: GalleryKind { GalleryKind(mime: file.mime) }

    var body: some View {
        Group {
            switch kind {
            case .picture:
                if let picture {
                    ZoomableImage(image: picture)
                        .accessibilityLabel(file.name)
                } else {
                    waiting
                }
            case .video:
                if let player {
                    VideoPlayer(player: player)
                } else {
                    waiting
                }
            case .document:
                if let whole {
                    DocumentPage(url: whole, name: file.name)
                } else {
                    waiting
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            // The Mac's small copy first, so a picture is there while the file itself comes.
            guard kind == .picture, picture == nil,
                  let preview = try? await model.preview(file.path, in: sessionId),
                  case .image(_, let data) = preview.preview else { return }
            if picture == nil { picture = UIImage(data: data) }
        }
        .task(id: isCurrent) {
            guard isCurrent, whole == nil else { return }
            do {
                let url = try await model.wholeFile(file.path, name: file.name, in: sessionId) { share in
                    Task { @MainActor in progress = share }
                }
                whole = url
                fetched(url)
                switch kind {
                case .picture:
                    let side = 4 * max(UIScreen.main.bounds.width, UIScreen.main.bounds.height)
                    if let full = await Task.detached(priority: .userInitiated, operation: { LocalThumbnail.thumbnail(url, pixels: side) }).value {
                        picture = full
                    }
                case .video:
                    player = AVPlayer(url: url)
                case .document:
                    break
                }
            } catch ChannelError.rpc(let refusal) where refusal.code == "METHOD_NOT_FOUND" {
                problem = "Update Realm on your Mac to open this file here."
            } catch is CancellationError {
            } catch {
                problem = AppModel.describe(error)
            }
        }
        .onChange(of: isCurrent) {
            if !isCurrent { player?.pause() }
        }
        .onDisappear { player?.pause() }
    }

    /// The file on its way, or why it cannot come; a picture's preview stands in where it has one.
    @ViewBuilder
    private var waiting: some View {
        if let problem {
            ContentUnavailableView(file.name, systemImage: FileKind.symbol(file.name), description: Text(problem))
        } else {
            VStack(spacing: 14) {
                Image(systemName: FileKind.symbol(file.name))
                    .font(.largeTitle)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Palette.ink2)
                ProgressView(value: progress)
                    .frame(width: 160)
                    .tint(Palette.ink2)
                Text("Getting it from your Mac")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(file.name), getting it from your Mac")
        }
    }
}

/// Every file of the message as a square tile: a picture is itself, edge to edge; anything else its name
/// at the head and its kind's glyph in the middle. The one on screen before is ringed.
private struct GalleryGrid: View {
    let pages: GalleryPages
    let sessionId: String
    let page: Int
    let pick: (Int) -> Void

    static let narrowestTile: CGFloat = 104
    /// An adaptive column is never as wide as two of the narrowest.
    static let widestTile: CGFloat = 2 * narrowestTile

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.narrowestTile), spacing: 6)], spacing: 6) {
                ForEach(pages.files.indices, id: \.self) { index in
                    Button { pick(index) } label: {
                        GalleryTile(file: pages.files[index], sessionId: sessionId)
                            .overlay {
                                if index == page {
                                    RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous)
                                        .strokeBorder(Palette.accent, lineWidth: 2)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(pages.files[index].name)
                    .accessibilityAddTraits(index == page ? .isSelected : [])
                }
            }
            .padding(16)
        }
    }
}

private struct GalleryTile: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    /// The Mac's preview made small enough for the tile, its short side covering the widest tile the grid
    /// lays out. The strip's thumbnail fits a smaller square, and filled out to a tile it goes soft.
    @State private var picture: UIImage?

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if file.isImage, let thumbnail = picture ?? model.thumbnail(file.path, in: sessionId) {
                    Image(uiImage: thumbnail)
                        .resizable()
                        .scaledToFill()
                } else {
                    VStack(spacing: 8) {
                        Text(file.name)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                        Image(systemName: FileKind.symbol(file.name))
                            .font(.title2)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(Palette.ink2)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Fill.bubble)
                }
            }
            .pictureTile()
            .task {
                guard file.isImage, let preview = try? await model.preview(file.path, in: sessionId),
                      case .image(_, let data) = preview.preview, let image = UIImage(data: data),
                      image.size.width > 0, image.size.height > 0 else { return }
                let scale = GalleryGrid.widestTile * displayScale / min(image.size.width, image.size.height)
                guard scale < 1 else { picture = image; return }
                picture = await image.byPreparingThumbnail(ofSize: CGSize(width: image.size.width * scale, height: image.size.height * scale)) ?? image
            }
    }
}

/// A picture to pinch and double-tap into, as Photos zooms one: UIKit's scroll view, which SwiftUI's
/// gestures cannot match for zooming about the fingers and bouncing at the ends.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.maximumZoomScale = 4
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(view)
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
        ])
        context.coordinator.imageView = view
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTapped(_ tap: UITapGestureRecognizer) {
            guard let scroll = tap.view as? UIScrollView else { return }
            if scroll.zoomScale > scroll.minimumZoomScale {
                scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
                return
            }
            let point = tap.location(in: imageView)
            let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
            scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

/// A document's first page, and Quick Look over the gallery from a tap on it, with Quick Look's own
/// Share and Save. Quick Look is not drawn in the page itself: it keeps every sideways swipe for its own
/// paging, and the gallery could never be swiped on from a document.
private struct DocumentPage: View {
    let url: URL
    let name: String
    @State private var cover: UIImage?
    @State private var previewing: URL?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        VStack(spacing: 20) {
            Button { previewing = url } label: {
                if let cover {
                    Image(uiImage: cover)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous)
                                .strokeBorder(Palette.ink.opacity(0.1))
                        }
                } else {
                    Image(systemName: FileKind.symbol(name))
                        .font(.largeTitle)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .buttonStyle(.plain)
            .frame(maxHeight: 460)
            .accessibilityLabel(name)
            .accessibilityHint("Opens it in Quick Look")
            Button("Open in Quick Look") { previewing = url }
                .buttonStyle(.bordered)
                .tint(Palette.ink)
        }
        .padding(32)
        .quickLookPreview($previewing)
        .task(id: url) {
            let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 320, height: 460), scale: displayScale, representationTypes: .thumbnail)
            cover = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
        }
    }
}

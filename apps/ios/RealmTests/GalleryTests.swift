import CoreGraphics
import RealmKit
import Testing
@testable import Realm

/// A message's files in the gallery: the order its row draws them, the page a tap opens on, and which
/// swipes open it.
struct GalleryTests {
    private static let photo = SentFile(path: "/Users/me/Realm/tmp/attachments/a1-IMG_0412.jpg", name: "IMG_0412.jpg", mime: "image/jpeg")
    private static let clip = SentFile(path: "/Users/me/Realm/tmp/attachments/b2-clip.mov", name: "clip.mov", mime: "video/quicktime")
    private static let deck = SentFile(path: "/Users/me/Realm/tmp/attachments/c3-deck.pdf", name: "deck.pdf", mime: "application/pdf")
    private static let sketch = SentFile(path: "/Users/me/Realm/tmp/attachments/d4-sketch.png", name: "sketch.png", mime: "image/png")

    @Test func pagesFollowTheRowPicturesFirst() {
        let pages = GalleryPages([Self.clip, Self.photo, Self.deck, Self.sketch])
        #expect(pages.files == [Self.photo, Self.sketch, Self.clip, Self.deck])
    }

    @Test func aTapOpensOnTheFileTapped() {
        let pages = GalleryPages([Self.clip, Self.photo, Self.deck, Self.sketch])
        #expect(pages.page(of: Self.photo) == 0)
        #expect(pages.page(of: Self.clip) == 2)
        #expect(pages.page(of: Self.deck) == 3)
        let stranger = SentFile(path: "/elsewhere/notes.md", name: "notes.md", mime: "text/markdown")
        #expect(pages.page(of: stranger) == 0)
    }

    @Test func thePositionCountsFromOneAndIsQuietForOneFile() {
        let pages = GalleryPages([Self.photo, Self.clip, Self.deck])
        #expect(pages.position(0) == "1 of 3")
        #expect(pages.position(2) == "3 of 3")
        #expect(GalleryPages([Self.photo]).position(0) == "")
    }

    @Test func eachFileIsShownByItsKind() {
        #expect(GalleryKind(mime: Self.photo.mime) == .picture)
        #expect(GalleryKind(mime: Self.clip.mime) == .video)
        #expect(GalleryKind(mime: Self.deck.mime) == .document)
        #expect(GalleryKind(mime: "text/markdown") == .document)
    }

    @Test func onlyALevelSwipeRightOpensTheGallery() {
        #expect(GalleryPages.opens(CGSize(width: 120, height: 10)))
        #expect(GalleryPages.opens(CGSize(width: 61, height: -30)))
        // Too short, leftwards, or a scroll down the transcript that drifted right.
        #expect(!GalleryPages.opens(CGSize(width: 40, height: 0)))
        #expect(!GalleryPages.opens(CGSize(width: -120, height: 0)))
        #expect(!GalleryPages.opens(CGSize(width: 90, height: 80)))
    }
}

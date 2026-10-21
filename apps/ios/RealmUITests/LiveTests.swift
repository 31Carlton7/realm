import XCTest

/// The app against a real Mac, relay and gateway, staged by `scripts/screens-live.mts --ui`. The
/// script moves the Mac between phases — awake, asleep, the relay gone — and runs one test per phase.
/// It hands the runner a pairing link and a folder for screenshots (`TEST_RUNNER_PAIR_LINK`,
/// `TEST_RUNNER_SHOTS`).
final class LiveTests: XCTestCase {
    private var app: XCUIApplication!
    private let environment = ProcessInfo.processInfo.environment

    override func setUp() {
        continueAfterFailure = false
    }

    /// The app, unattended so it asks for no permission, with any launch arguments the phase adds.
    @MainActor
    private func launch(_ arguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = ["-unattended", "1"] + arguments
        app.launch()
    }

    // MARK: - Phases

    /// Forgets whatever Mac the app showed, then pairs with the staged one through its link. The Mac
    /// holds its answer for a few seconds, which is when the phone says to confirm there.
    @MainActor
    func test0_forgetThenPair() throws {
        launch()
        // Home is titled with its profile, so it is known by its Settings button.
        let settings = app.navigationBars.buttons["settings"]
        if settings.waitForExistence(timeout: 8) {
            settings.tap()
            let forget = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Forget ")).firstMatch
            XCTAssert(forget.waitForExistence(timeout: 5))
            shot("settings")
            forget.tap()
            let confirm = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Forget ")).element(boundBy: 1)
            XCTAssert(confirm.waitForExistence(timeout: 5))
            confirm.tap()
        }
        XCTAssert(app.buttons["Scan the code"].waitForExistence(timeout: 10))
        shot("pair")
        app.buttons["Paste the link"].tap()
        XCTAssert(app.navigationBars["Paste the link"].waitForExistence(timeout: 5))
        shot("pair-paste")
        app.navigationBars["Paste the link"].buttons["Cancel"].tap()
        let link = try XCTUnwrap(environment["PAIR_LINK"], "the staging script passes a pairing link")
        app.terminate()
        launch(["-pairLink", link])
        XCTAssert(element(containing: "Confirm on your Mac").waitForExistence(timeout: 15))
        shot("pair-confirm")
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
    }

    /// Home, a permission and a question; the question's sheet put away answers nothing; a message
    /// sent shows until the Mac has it; a plan and an error with its fix.
    @MainActor
    func test1_awake() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 10))
        shot("home")
        app.swipeUp()
        shot("home-spaces")
        app.swipeDown()

        open("Add the dark-mode toggle")
        XCTAssert(text("Allow Bash?").waitForExistence(timeout: 10))
        shot("session-request")
        // Folded away, the request leaves the composer its place, with Stop beside it.
        app.buttons["Fold"].tap()
        XCTAssert(element(containing: "is waiting on you").waitForExistence(timeout: 5))
        let read = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Read apps")).firstMatch
        if read.waitForExistence(timeout: 3) {
            read.tap()
            shot("session-tool-open")
        }
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "is waiting on you")).firstMatch.tap()
        XCTAssert(app.buttons["Allow"].waitForExistence(timeout: 5), "the request did not come back")
        back()

        open("Choose the database")
        let answer = app.buttons["Answer"]
        XCTAssert(answer.waitForExistence(timeout: 10))
        shot("session-question")
        answer.tap()
        let sqlite = app.buttons["SQLite"]
        XCTAssert(sqlite.waitForExistence(timeout: 5))
        sqlite.tap()
        app.buttons["us-east-1"].tap()
        // Every question answered, so a sheet that answered on its way out would have something to send.
        // The token is a secret: its field is masked.
        let token = app.secureTextFields["Your answer"].exists ? app.secureTextFields["Your answer"] : app.textFields["Your answer"]
        token.tap()
        token.typeText("staging-token")
        // The sheet is headed by who asks, as the Mac names the asker.
        let sheet = app.navigationBars.matching(NSPredicate(format: "identifier ENDSWITH %@", " asks")).firstMatch
        XCTAssert(sheet.buttons["Send"].isEnabled, "the answers are complete")
        shot("question-sheet")
        // Dragging the sheet away is a way out, never an answer.
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssert(sheet.waitForNonExistence(timeout: 5), "the sheet did not go away")
        XCTAssert(app.buttons["Continue answering"].waitForExistence(timeout: 5), "the picks were not kept")
        sleep(3)
        XCTAssertFalse(element(containing: "Sending").exists, "putting the sheet away sent an answer")
        XCTAssert(app.buttons["Skip"].exists, "putting the sheet away answered the request")
        shot("question-put-away")
        back()

        open("Explain the relay")
        XCTAssert(element(containing: "How the relay works").waitForExistence(timeout: 10)
                  || element(containing: "dials out").waitForExistence(timeout: 5))
        shot("session-markdown")
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        field.tap()
        field.typeText("Ship it on Friday")
        shot("composer-typing")
        app.buttons["Send"].tap()
        XCTAssert(element(containing: "echo: Ship it on Friday").waitForExistence(timeout: 15), "the Mac never answered the message")
        XCTAssertFalse(element(containing: "Sending").exists)
        shot("session-sent")
        back()

        open("Fix the org access crash")
        let changed = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Changed 3 files")).firstMatch
        XCTAssert(changed.waitForExistence(timeout: 10), "the turn's changes are not drawn")
        shot("session-changes")
        // The finished turn's work folds under one line; an edit in it opens onto its own diff.
        let fold = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssert(fold.waitForExistence(timeout: 5), "the turn's work did not fold")
        // The session opens at its newest row; the fold is above the answer.
        for _ in 0..<6 where !fold.isHittable { app.swipeDown(velocity: .slow) }
        fold.tap()
        let edited = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Edited web/lib/orgs.ts")).firstMatch
        XCTAssert(edited.waitForExistence(timeout: 5), "the fold did not open onto the edits")
        edited.tap()
        XCTAssert(element(containing: "Open the diff").waitForExistence(timeout: 10), "the edit's diff did not open in its line")
        shot("session-inline-diff")
        changed.tap()
        let orgs = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "orgs.ts")).firstMatch
        XCTAssert(orgs.waitForExistence(timeout: 10), "the changed files did not load")
        shot("changes-sheet")
        orgs.tap()
        XCTAssert(element(containing: "withInviteDefaults").waitForExistence(timeout: 10), "the diff did not load")
        shot("diff")
        back()
        app.navigationBars.buttons["Done"].firstMatch.tap()
        let picture = app.buttons["connections-page.png"]
        for _ in 0..<4 where !picture.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssert(picture.exists, "the picture the turn made is not drawn")
        picture.tap()
        XCTAssert(app.images["connections-page.png"].waitForExistence(timeout: 10), "the picture did not arrive")
        shot("file-preview")
        app.navigationBars.buttons["Done"].firstMatch.tap()
        // A turn under way: the pill says how long it has worked, and the way back to the newest row
        // slides out of the same glass once the reader scrolls away.
        let message = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        message.tap()
        message.typeText("keep working on the review")
        app.buttons["Send"].tap()
        let pill = element(containing: "Working, ")
        XCTAssert(pill.waitForExistence(timeout: 15), "the pill did not say the turn is working")
        sleep(2)
        // A drag down into the keyboard puts it away and scrolls the reader off the newest row.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97)))
        XCTAssert(app.buttons["Latest"].waitForExistence(timeout: 5), "scrolled away, there was no way back to the newest row")
        sleep(1)
        shot("session-working-latest")
        app.buttons["Latest"].tap()
        sleep(3)
        shot("session-working")
        app.buttons["Stop"].firstMatch.tap()
        XCTAssert(pill.waitForNonExistence(timeout: 15), "Stop did not end the turn")
        back()

        open("Rework the transcript mapper")
        XCTAssert(element(containing: "Carry the plan as its own event").waitForExistence(timeout: 10))
        shot("session-plan")
        back()

        open("Train the social model")
        XCTAssert(element(containing: "limit").waitForExistence(timeout: 10))
        shot("session-error")
        back()

        app.navigationBars.buttons["Settings"].tap()
        XCTAssert(element(containing: "Relay").waitForExistence(timeout: 5))
        shot("settings-connected")
    }

    /// The Mac is asleep: Home says so from the cache, and an answer given now waits in the outbox.
    @MainActor
    func test2_asleep() throws {
        launch()
        XCTAssert(element(containing: "Asleep since").waitForExistence(timeout: 90), "the phone was never told the Mac slept")
        XCTAssert(element(containing: "Updated").exists, "Home does not say how old its copy is")
        shot("asleep-home")
        open("Add the dark-mode toggle")
        let allow = app.buttons["Allow"]
        XCTAssert(allow.waitForExistence(timeout: 10))
        allow.tap()
        XCTAssert(element(containing: "Your Mac is asleep. This sends when it wakes.").waitForExistence(timeout: 5))
        shot("asleep-answer-waiting")
    }

    /// The Mac woke: the answer given while it slept went, after a relaunch, without being given again.
    @MainActor
    func test3_awakeAgain() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        open("Add the dark-mode toggle")
        XCTAssert(text("Allowed").waitForExistence(timeout: 30), "the answer kept while the Mac slept never went")
        shot("answer-delivered")
    }

    /// The relay is gone: the phone says it cannot reach it, rather than looking stuck.
    @MainActor
    func test4_relayDown() throws {
        launch()
        XCTAssert(element(containing: "Can't reach the relay").waitForExistence(timeout: 40))
        shot("relay-unreachable")
    }

    /// The largest accessibility text size: Home, a session and its question card still read whole.
    @MainActor
    func test5_largestText() throws {
        launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
        shot("ax-home")
        open("Choose the database")
        XCTAssert(app.buttons["Skip"].waitForExistence(timeout: 10))
        shot("ax-session-question")
        back()
        open("Explain the relay")
        // A long session opens at its newest message, whatever the text size: the reply to what the
        // awake phase sent, or the prose's last line where that phase did not run.
        let echo = element(containing: "echo: Ship it on Friday"), last = element(containing: "for the rest")
        _ = echo.waitForExistence(timeout: 10) || last.waitForExistence(timeout: 5)
        sleep(1)
        shot("ax-session-markdown")
        XCTAssert((echo.exists && echo.isHittable) || (!echo.exists && last.exists && last.isHittable),
                  "the session did not open at its newest message")
    }

    /// Reduce Transparency, set on the Simulator by the script: the glass the composer and the bars
    /// wear goes solid enough to read on.
    @MainActor
    func test6_reduceTransparency() throws {
        launch()
        XCTAssert(app.staticTexts["Needs you"].waitForExistence(timeout: 30))
        shot("rt-home")
        open("Add the dark-mode toggle")
        XCTAssert(text("Allowed").waitForExistence(timeout: 10))
        shot("rt-session")
    }

    // MARK: - Home, one profile at a time (Plan 29)

    /// Work by space, with a line for what needs you in School; the title's menu; School, and back to
    /// Work from its line; then every profile at once.
    @MainActor
    func testH1_profiles() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        XCTAssert(elsewhere("School").waitForExistence(timeout: 10), "nothing says what needs you in School")
        XCTAssertFalse(element(containing: "Check the proof for question 2").exists, "School's session is listed in Work")
        shot("home-work")
        let showAll = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Show all")).firstMatch
        for _ in 0..<4 where !showAll.exists { app.swipeUp(velocity: .slow) }
        XCTAssert(showAll.exists, "Realm holds more than Home lists, and nothing says so")
        shot("home-work-show-all")
        // Switched from part way down, the other profile's list opens at its top.
        titleButton.tap()
        XCTAssert(menuItem("School").waitForExistence(timeout: 5), "the title has no menu of profiles")
        shot("profile-menu")
        menuItem("School").tap()
        XCTAssert(waitForTitle("School"))
        XCTAssert(elsewhere("Work").waitForExistence(timeout: 5) && elsewhere("Work").isHittable, "School's list did not open at its top")
        XCTAssert(element(containing: "Check the proof for question 2").waitForExistence(timeout: 10))
        XCTAssertFalse(element(containing: "Add the dark-mode toggle").exists, "Work's session is listed in School")
        shot("home-school")
        // The choice is kept on the phone.
        app.terminate()
        launch()
        XCTAssert(waitForTitle("School"), "the profile chosen was not kept")
        elsewhere("Work").tap()
        XCTAssert(waitForTitle("Work"), "the line did not show Work")
        showProfile("All profiles")
        XCTAssert(element(containing: "Check the proof for question 2").waitForExistence(timeout: 10))
        XCTAssert(element(containing: "Add the dark-mode toggle").exists)
        XCTAssertFalse(elsewhere("School").exists, "every profile is shown, and a line still points at one")
        shot("home-all")
        showProfile("Work")
    }

    /// The View options menu, and each way of listing: Most recent, By day, Needs you in place, the
    /// spaces by their activity.
    @MainActor
    func testH2_listStyles() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        app.buttons["view-options"].tap()
        XCTAssert(app.buttons["Most recent"].waitForExistence(timeout: 5), "no View options menu")
        shot("view-options")
        app.buttons["Most recent"].tap()
        XCTAssert(app.staticTexts["Recent"].waitForExistence(timeout: 5), "Most recent is not one list")
        XCTAssert(app.staticTexts["Needs you"].exists)
        shot("home-most-recent")
        viewOption("By day")
        XCTAssert(app.staticTexts["Today"].waitForExistence(timeout: 5))
        shot("home-by-day")
        // A list draws only the rows near the screen: each day's head is looked for on the way down.
        var heads: Set<String> = []
        for _ in 0..<10 where !app.staticTexts["Earlier"].exists {
            for day in ["Yesterday", "Previous 7 days"] where app.staticTexts[day].exists { heads.insert(day) }
            app.swipeUp(velocity: .slow)
        }
        for day in ["Yesterday", "Previous 7 days"] where app.staticTexts[day].exists { heads.insert(day) }
        XCTAssertEqual(heads, ["Yesterday", "Previous 7 days"], "a day has no sessions under it")
        XCTAssert(app.staticTexts["Earlier"].exists, "nothing is listed under Earlier")
        shot("home-by-day-earlier")
        viewOption("Needs you first", selected: false)
        XCTAssert(app.staticTexts["Needs you"].waitForNonExistence(timeout: 5), "Needs you still heads the list")
        app.swipeDown()
        shot("home-needs-you-in-place")
        viewOption("Needs you first")
        viewOption("By space")
        viewOption("Recently active first")
        XCTAssert(app.buttons["view-options"].waitForExistence(timeout: 5))
        shot("home-recently-active")
        viewOption("As on your Mac")
    }

    /// Settings ▸ Session list changes what Home's menu changes.
    @MainActor
    func testH3_sessionListSettings() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        app.navigationBars.buttons["settings"].tap()
        let list = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "List")).firstMatch
        for _ in 0..<4 where !list.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssert(list.exists, "Settings has no Session list")
        shot("settings-session-list")
        list.tap()
        XCTAssert(app.buttons["By day"].waitForExistence(timeout: 5))
        app.buttons["By day"].tap()
        XCTAssertFalse(element(containing: "Order spaces").waitForExistence(timeout: 2), "Order spaces is offered for a list by day")
        shot("settings-session-list-by-day")
        app.navigationBars.buttons["Done"].firstMatch.tap()
        XCTAssert(app.staticTexts["Today"].waitForExistence(timeout: 5), "Home did not follow Settings")
        viewOption("By space")
    }

    /// A space's page, from its "Show all" row: its glyph and name for a title, its newest first, the
    /// second page as the end of the first comes into view, and a search of what has come.
    @MainActor
    func testH4_spacePage() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        showProfile("Personal")
        // Most recent is the Mac's own list for Personal, which reaches far past Journal's newest few.
        viewOption("Most recent")
        let older = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal entry 40,")).firstMatch
        for _ in 0..<12 where !older.exists { app.swipeUp() }
        XCTAssert(older.exists, "Personal's recent sessions are not the Mac's list for Personal")
        shot("home-personal-most-recent")
        viewOption("By space")
        let showAll = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Show all 55")).firstMatch
        for _ in 0..<8 where !showAll.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssert(showAll.exists, "Journal's 55 sessions have no Show all")
        showAll.tap()
        XCTAssert(app.navigationBars["Journal"].waitForExistence(timeout: 10), "the page is not titled with the space")
        XCTAssert(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal entry 55,")).firstMatch.waitForExistence(timeout: 10))
        shot("space-page")
        let first = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal entry 1,")).firstMatch
        for _ in 0..<30 where !first.exists { app.swipeUp() }
        XCTAssert(first.exists, "the second page never came")
        shot("space-page-second")
        app.searchFields.firstMatch.tap()
        app.searchFields.firstMatch.typeText("entry 7")
        XCTAssert(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal entry 7,")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Journal entry 8,")).firstMatch.exists)
        shot("space-page-search")
        // While it searches, the page gives its bar to the field; the button beside the field ends the
        // search and gives the bar back.
        let field = app.searchFields.firstMatch.frame
        let close = app.buttons.allElementsBoundByIndex.first { $0.frame.minX >= field.maxX && abs($0.frame.midY - field.midY) < 20 }
        try XCTUnwrap(close, "nothing beside the search field ends it").tap()
        back()
        showProfile("Work")
    }

    /// The dark face, set on the Simulator by the script: Home, its menus, By day and a space's page,
    /// opened from its head.
    @MainActor
    func testH5_dark() throws {
        try appearanceTour(prefix: "dark")
    }

    /// The largest accessibility text size: the title's menu, the line for another profile, the menus,
    /// By day, a space's page and Settings ▸ Session list still read whole.
    @MainActor
    func testH6_largestText() throws {
        launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        XCTAssert(app.navigationBars.buttons["settings"].waitForExistence(timeout: 30))
        sleep(3)
        try appearanceTour(prefix: "ax", launched: true)
        app.navigationBars.buttons["settings"].tap()
        let list = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "List")).firstMatch
        for _ in 0..<12 where !list.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssert(list.exists)
        shot("ax-settings-session-list")
        app.navigationBars.buttons["Done"].firstMatch.tap()
    }

    /// Reduce Transparency, set on the Simulator by the script: the bars and menus over Home.
    @MainActor
    func testH7_reduceTransparency() throws {
        try appearanceTour(prefix: "rt")
    }

    /// Home by space, the title's menu, View options, By day and a space's page from its head, each
    /// pictured under `prefix`, and Home left as it was found.
    @MainActor
    private func appearanceTour(prefix: String, launched: Bool = false) throws {
        if !launched {
            launch()
            XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        }
        resetHome()
        shot("\(prefix)-home-work")
        titleButton.tap()
        XCTAssert(menuItem("School").waitForExistence(timeout: 5))
        shot("\(prefix)-profile-menu")
        dismissMenu()
        app.buttons["view-options"].tap()
        XCTAssert(app.buttons["By day"].waitForExistence(timeout: 5))
        shot("\(prefix)-view-options")
        app.buttons["By day"].tap()
        XCTAssert(app.staticTexts["Today"].waitForExistence(timeout: 5))
        shot("\(prefix)-by-day")
        viewOption("By space")
        let realm = app.buttons["Realm"]
        for _ in 0..<6 where !realm.isHittable { app.swipeUp(velocity: .slow) }
        realm.tap()
        XCTAssert(app.navigationBars["Realm"].waitForExistence(timeout: 10), "the space's head did not open its page")
        sleep(2)
        shot("\(prefix)-space-page")
        back()
    }

    // MARK: - Helpers

    /// Home's title, which opens the menu of profiles.
    @MainActor
    private var titleButton: XCUIElement {
        app.navigationBars.firstMatch.buttons.matching(NSPredicate(format: "identifier != 'settings' AND label != 'Reconnect'")).firstMatch
    }

    @MainActor
    private func waitForTitle(_ title: String) -> Bool {
        app.navigationBars.firstMatch.buttons[title].waitForExistence(timeout: 10)
    }

    /// An item of the profiles' menu, which says what needs you after the name: not the title, which
    /// can say the same name.
    @MainActor
    private func menuItem(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", name, "\(name), ")).element(boundBy: titleButton.label == name ? 1 : 0)
    }

    /// The line at the head of Home saying what needs you in another profile.
    @MainActor
    private func elsewhere(_ profile: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'elsewhere-' AND label ENDSWITH %@", " in \(profile)")).firstMatch
    }

    @MainActor
    private func showProfile(_ name: String) {
        guard titleButton.label != name else { return }
        titleButton.tap()
        let item = menuItem(name)
        XCTAssert(item.waitForExistence(timeout: 5), "no \(name) in the title's menu")
        item.tap()
        XCTAssert(waitForTitle(name), "Home did not show \(name)")
    }

    /// Presses one of View options, unless it is already as asked.
    @MainActor
    private func viewOption(_ name: String, selected: Bool = true) {
        app.buttons["view-options"].tap()
        let item = app.buttons[name]
        // At the largest sizes the menu scrolls, and holds only the items in view; the first group is
        // nearest the button, the rest above it.
        let menu = app.collectionViews.containing(NSPredicate(format: "label == %@", "By space")).firstMatch
        for _ in 0..<3 where !item.waitForExistence(timeout: 2) { menu.swipeDown() }
        XCTAssert(item.exists, "no \(name) in View options")
        if item.isSelected == selected { dismissMenu() } else { item.tap() }
        sleep(1)
    }

    /// A press beside an open menu, which closes it: on the bar left of the title, where Home has
    /// nothing to press. The status bar is the system's, and an open menu never hears it.
    @MainActor
    private func dismissMenu() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.1)).tap()
        sleep(1)
    }

    /// Home as a phase expects to find it, whatever one before left: Work, by space, Needs you first,
    /// the spaces as on the Mac.
    @MainActor
    private func resetHome() {
        XCTAssert(titleButton.waitForExistence(timeout: 10))
        showProfile("Work")
        viewOption("By space")
        viewOption("Needs you first")
        viewOption("As on your Mac")
    }

    /// Words on screen, the first where a card and the dock both say them.
    @MainActor
    private func text(_ words: String) -> XCUIElement {
        app.staticTexts.matching(identifier: words).firstMatch
    }

    @MainActor
    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Opens a session from its row on Home. The row is scrolled until its head is clear of the bars
    /// — a row under the search field is not one a person can press — and pressed there, since at
    /// the largest text sizes its middle can be off the screen.
    @MainActor
    private func open(_ title: String) {
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        // A list makes the rows near the screen, so one further down exists only once scrolled to.
        if !row.waitForExistence(timeout: 10) {
            for _ in 0..<12 where !row.exists { app.swipeUp(velocity: .slow) }
        }
        XCTAssert(row.exists, "no row for \(title)")
        let screen = app.windows.firstMatch.frame
        let clear = (screen.minY + 180)...(screen.maxY - 220)
        for _ in 0..<12 {
            let head = row.frame.minY + 24
            if clear.contains(head) { break }
            if head > clear.upperBound { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
        }
        row.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: row.frame.width / 2, dy: 24)).tap()
    }

    @MainActor
    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// After a push, a sheet or a send: lets the transition land before the picture is taken.
    @MainActor
    private func shot(_ name: String) {
        usleep(900_000)
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = environment["SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
        }
    }
}

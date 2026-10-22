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
        // Home is titled with its profile, so it is known by the menu in its bar.
        if app.navigationBars.buttons["home-menu"].waitForExistence(timeout: 8) {
            openSettings()
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

        openSettings()
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
        openSettings()
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
        XCTAssert(app.navigationBars.buttons["home-menu"].waitForExistence(timeout: 30))
        sleep(3)
        try appearanceTour(prefix: "ax", launched: true)
        // Settings ▸ Session list sets its choices out as rows here, each whole.
        openSettings()
        let bySpace = element(containing: "By space")
        for _ in 0..<12 where !(bySpace.exists && bySpace.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssert(bySpace.exists, "Settings has no Session list")
        shot("ax-settings-session-list")
        let recently = element(containing: "Recently active first")
        for _ in 0..<6 where !(recently.exists && recently.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssert(recently.exists)
        shot("ax-settings-session-list-order")
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
        // Needs you can fill the screen at the largest sizes: the first day's head is further down.
        let today = app.staticTexts["Today"]
        for _ in 0..<6 where !today.waitForExistence(timeout: 2) { app.swipeUp(velocity: .slow) }
        XCTAssert(today.exists, "By day has no Today")
        shot("\(prefix)-by-day")
        viewOption("By space")
        let realm = app.buttons["Realm"]
        for _ in 0..<6 where !realm.exists { app.swipeUp(velocity: .slow) }
        pressClearOfTheBars(realm)
        XCTAssert(app.navigationBars["Realm"].waitForExistence(timeout: 10), "the space's head did not open its page")
        sleep(2)
        shot("\(prefix)-space-page")
        back()
    }

    // MARK: - Sub-agents, Usage, Review and Scheduled

    /// A lead session that started sub-agents counts them in its bar, with the working mark while one
    /// runs; its sheet lists them newest first, and the one that finished opens its own session over the
    /// lead's, the lead a press back.
    @MainActor
    func testQ1_subagents() throws {
        let lead = try XCTUnwrap(environment["LEAD_SESSION"], "the script names the lead session")
        let finished = try XCTUnwrap(environment["SUBAGENT_DONE"], "the script names the sub-agent that finished")
        let title = try XCTUnwrap(environment["SUBAGENT_DONE_TITLE"], "the script names its session's title")
        launch(["-openSession", lead])
        let control = app.buttons["subagents"]
        XCTAssert(control.waitForExistence(timeout: 30), "the lead's bar does not count its sub-agents")
        XCTAssert(control.label.hasSuffix(" sub-agents"), "the bar says \(control.label)")
        dismissAccountPrompt()
        shot("subagents-control")
        control.tap()
        XCTAssert(app.navigationBars["Sub-agents"].waitForExistence(timeout: 10), "the sub-agents' sheet did not open")
        let done = app.buttons["subagent-\(finished)"]
        XCTAssert(done.waitForExistence(timeout: 10), "the sub-agent that finished is not listed")
        XCTAssert(done.label.contains(", Done, "), "the sub-agent that finished says \(done.label)")
        XCTAssert(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", ", Working, ")).firstMatch.exists, "no sub-agent says it is working")
        sleep(1)
        shot("subagents-sheet")
        done.tap()
        XCTAssert(app.navigationBars[title].waitForExistence(timeout: 15), "the sub-agent's own session did not open")
        sleep(2)
        shot("subagent-session")
        back()
        XCTAssert(control.waitForExistence(timeout: 15), "back did not lead to the lead")
    }

    /// The menu in Home's bar, then Usage from it: each plan's windows as bars with what is used and
    /// when they reset, then the month's spend against its budget and the costliest sessions, one of
    /// which opens; pulled down, the page is read again.
    @MainActor
    func testQ2_menuAndUsage() throws {
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        openMenu()
        XCTAssert(menuPage("Review").exists && menuPage("Scheduled").exists && menuPage("Usage").exists, "the bar's menu does not offer the pages")
        XCTAssert(menuPage("Review").label.hasSuffix(" to review"), "the menu does not say what waits in Review")
        shot("home-menu")
        menuPage("Usage").tap()
        XCTAssert(app.navigationBars["Usage"].waitForExistence(timeout: 10), "Usage did not open")
        XCTAssert(element(containing: "% used · resets in").waitForExistence(timeout: 20), "no window says what is used and when it resets")
        shot("usage")
        app.swipeDown(velocity: .slow)
        XCTAssert(element(containing: "% used · resets in").waitForExistence(timeout: 20), "pulled down, the page lost its plans")
        let budget = element(containing: "budget")
        for _ in 0..<6 where !(budget.exists && budget.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssert(budget.exists, "the month's spend is not set against its budget")
        shot("usage-spend")
        let costliest = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "$")).firstMatch
        XCTAssert(costliest.exists, "no costliest session is listed")
        costliest.tap()
        XCTAssert(composerField.waitForExistence(timeout: 20), "the costliest session did not open")
        back()
        XCTAssert(app.navigationBars["Usage"].waitForExistence(timeout: 10))
    }

    /// Scheduled, from Home's head line for a run that finished unread: every task with its space, when
    /// it runs and next, its last run's state and the unread mark; Run now from a swipe, which the
    /// script checks the Mac started; and a task opening the session its last run ran in.
    @MainActor
    func testQ3_scheduled() throws {
        let task = try XCTUnwrap(environment["TASK_TO_RUN"], "the script names a task to run")
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        let line = app.buttons["head-scheduled"]
        XCTAssert(line.waitForExistence(timeout: 15), "Home's head does not say a scheduled run finished unread")
        shot("home-head-lines")
        line.tap()
        XCTAssert(app.navigationBars["Scheduled"].waitForExistence(timeout: 10), "the line did not open Scheduled")
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "\(task),")).firstMatch
        XCTAssert(row.waitForExistence(timeout: 10), "no row for \(task)")
        shot("scheduled")
        row.swipeLeft()
        let runNow = app.buttons["Run now"]
        XCTAssert(runNow.waitForExistence(timeout: 5), "no Run now in the row's swipe")
        shot("scheduled-swipe")
        runNow.tap()
        XCTAssert(element(containing: "Started “\(task)”").waitForExistence(timeout: 15), "Run now did not start the task")
        shot("scheduled-run-now")
        // The run's end is the Mac's to say: the row hears of it only through work.changed.
        let ended = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "\(task), Last run Finished")).firstMatch
        XCTAssert(ended.waitForExistence(timeout: 90), "the run's end never reached the phone")
        shot("scheduled-run-finished")
        let unread = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", ", Unread, ")).firstMatch
        XCTAssert(unread.waitForExistence(timeout: 10), "no task's last run is unread")
        unread.tap()
        XCTAssert(composerField.waitForExistence(timeout: 20), "the run's session did not open")
        sleep(1)
        shot("scheduled-run-session")
        back()
    }

    /// The dark face, set on the Simulator by the script: the sub-agents' sheet, the menu, Usage, Review
    /// and a review's page, and Scheduled.
    @MainActor
    func testQ4_dark() throws {
        try workTour(prefix: "dark")
    }

    /// The largest accessibility text size: the same pages, still read whole.
    @MainActor
    func testQ5_largestText() throws {
        try workTour(prefix: "ax", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    }

    /// Reduce Transparency, set on the Simulator by the script: the bars, the dock and the menu go solid.
    @MainActor
    func testQ6_reduceTransparency() throws {
        try workTour(prefix: "rt")
    }

    /// Review from Home's head line: the open reviews, then one's page — its drafts, where each goes,
    /// its picture in Quick Look, and what Approve does, said before it is pressed — and Ask for changes,
    /// which sends nothing without a note and goes with one. The script checks the Mac has the note.
    @MainActor
    func testQ7_review() throws {
        let title = try XCTUnwrap(environment["REVIEW_TITLE"], "the script names the review to open")
        let picture = try XCTUnwrap(environment["REVIEW_PICTURE"], "the script names the review's picture")
        let note = try XCTUnwrap(environment["REVIEW_NOTE"], "the script names the note to send")
        launch()
        XCTAssert(element(containing: "· Connected").waitForExistence(timeout: 30))
        resetHome()
        let line = app.buttons["head-reviews"]
        XCTAssert(line.waitForExistence(timeout: 15), "Home's head does not say what waits in Review")
        XCTAssert(line.label.hasSuffix(" to review"), "the line says \(line.label)")
        line.tap()
        XCTAssert(app.navigationBars["Review"].waitForExistence(timeout: 10), "the line did not open Review")
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(title),")).firstMatch
        XCTAssert(row.waitForExistence(timeout: 10), "no row for \(title)")
        shot("reviews")
        row.tap()
        XCTAssert(element(containing: "Approving").waitForExistence(timeout: 15), "the page does not say what Approve does")
        let tile = app.buttons[picture]
        XCTAssert(tile.waitForExistence(timeout: 15), "the review's picture is not drawn")
        XCTAssert(tile.wait(for: \.isEnabled, toEqual: true, timeout: 20), "the review's picture never came")
        sleep(1)
        shot("review")
        tile.tap()
        let done = quickLookDone()
        sleep(1)
        shot("review-picture")
        done.tap()
        XCTAssert(done.waitForNonExistence(timeout: 10), "Quick Look did not close")
        app.buttons["Ask for changes"].tap()
        let sheet = app.navigationBars["Ask for changes"]
        XCTAssert(sheet.waitForExistence(timeout: 5), "Ask for changes did not open its note")
        XCTAssertFalse(sheet.buttons["Send"].isEnabled, "Ask for changes would go without a note")
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        field.typeText(note)
        XCTAssert(sheet.buttons["Send"].isEnabled, "with a note, Ask for changes still cannot go")
        shot("review-ask-for-changes")
        sheet.buttons["Send"].tap()
        XCTAssert(element(containing: "for changes.").waitForExistence(timeout: 15), "nothing said the Mac took the note")
        XCTAssert(app.navigationBars["Review"].waitForExistence(timeout: 10), "the page did not go back to the list")
        sleep(1)
        shot("review-asked")
    }

    /// The sub-agents' sheet, the menu, Usage, Review and a review's page, and Scheduled, each pictured
    /// under `prefix`.
    @MainActor
    private func workTour(prefix: String, _ arguments: [String] = []) throws {
        let lead = try XCTUnwrap(environment["LEAD_SESSION"], "the script names the lead session")
        let title = try XCTUnwrap(environment["REVIEW_TITLE"], "the script names the review to open")
        launch(["-openSession", lead] + arguments)
        let control = app.buttons["subagents"]
        XCTAssert(control.waitForExistence(timeout: 30), "the lead's bar does not count its sub-agents")
        dismissAccountPrompt()
        shot("\(prefix)-subagents-control")
        control.tap()
        XCTAssert(app.navigationBars["Sub-agents"].waitForExistence(timeout: 10))
        sleep(1)
        shot("\(prefix)-subagents-sheet")
        app.navigationBars["Sub-agents"].buttons["Done"].tap()
        back()
        resetHome()
        shot("\(prefix)-home-head")
        openMenu()
        shot("\(prefix)-home-menu")
        menuPage("Usage").tap()
        XCTAssert(element(containing: "% used").waitForExistence(timeout: 20), "Usage drew no window")
        shot("\(prefix)-usage")
        app.swipeUp(velocity: .slow)
        shot("\(prefix)-usage-spend")
        back()
        openMenu()
        menuPage("Review").tap()
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(title),")).firstMatch
        XCTAssert(row.waitForExistence(timeout: 10), "no row for \(title)")
        shot("\(prefix)-reviews")
        row.tap()
        XCTAssert(element(containing: "Approving").waitForExistence(timeout: 15))
        sleep(2)
        shot("\(prefix)-review")
        app.swipeUp(velocity: .slow)
        shot("\(prefix)-review-end")
        back()
        back()
        openMenu()
        menuPage("Scheduled").tap()
        XCTAssert(app.navigationBars["Scheduled"].waitForExistence(timeout: 10))
        sleep(1)
        shot("\(prefix)-scheduled")
        back()
    }

    // MARK: - The composer (Plan 29 §1)

    /// The composer at rest, then composing — the model and mode chips under the words — and the model
    /// chip's sheet with another model picked, the chip saying it; then Plan, from the mode chip's menu.
    /// The script checks after that the Mac has both.
    @MainActor
    func testC1_composer() throws {
        try openComposer()
        XCTAssertFalse(modelChip.exists, "at rest the composer is one capsule, with no chips")
        shot("composer-rest")
        composerField.tap()
        XCTAssert(modelChip.waitForExistence(timeout: 5), "composing, the composer has no model chip")
        shot("composer-focused")
        composerField.typeText("Read the composer's code first")
        shot("composer-typing")
        modelChip.tap()
        let opus = app.buttons["Opus 5.5"]
        XCTAssert(opus.waitForExistence(timeout: 10), "the sheet does not list the agent's models")
        shot("settings-sheet")
        opus.tap()
        XCTAssert(opus.wait(for: \.isSelected, toEqual: true, timeout: 10), "the check did not move to the model picked")
        shot("settings-model-picked")
        app.swipeUp(velocity: .slow)
        shot("settings-sheet-permissions")
        app.navigationBars.buttons["Done"].firstMatch.tap()
        XCTAssert(app.buttons["Model, Opus 5.5"].waitForExistence(timeout: 10), "the chip does not say the model picked")
        XCTAssert(modeChip.wait(for: \.isEnabled, toEqual: true, timeout: 10), "the mode chip stayed off after the Mac answered")
        shot("composer-chip-updated")
        modeChip.tap()
        let plan = app.buttons["Plan"]
        XCTAssert(plan.waitForExistence(timeout: 5), "the mode chip has no menu of modes")
        shot("mode-menu")
        plan.tap()
        XCTAssert(app.buttons["Mode, Plan"].waitForExistence(timeout: 10), "the chip does not say Plan")
        shot("composer-plan")
    }

    /// A photo in the composer, as the camera hands one over; then `+` and what it offers, and a second
    /// photo picked from the library, which the script put there; both sent with words and shown under
    /// the message once the Mac has them, a tile opening the Mac's copy.
    @MainActor
    func testC2_photo() throws {
        let photo = try XCTUnwrap(environment["STAGED_PHOTO"], "the script stages a photo")
        try openComposer(["-stagePhoto", photo])
        XCTAssert(app.buttons["Photo.jpg"].waitForExistence(timeout: 15), "the photo is not in the composer")
        shot("composer-photo")
        app.buttons["Add photos or files"].tap()
        XCTAssert(app.buttons["Photo library"].waitForExistence(timeout: 5), "+ offers no photos")
        XCTAssert(app.buttons["Choose files"].exists, "+ offers no files")
        shot("add-menu")
        app.buttons["Photo library"].tap()
        // The picker draws outside the app; the photo the script added is the one taken today. The
        // Simulator's library can hold others that only its iCloud has, which cannot be loaded here.
        let today = Date().formatted(.dateTime.month(.wide).day())
        let added = app.images.matching(NSPredicate(format: "identifier == 'PXGGridLayout-Info' AND label CONTAINS %@", today)).firstMatch
        XCTAssert(added.waitForExistence(timeout: 15), "the photo picker does not show the photo added today")
        sleep(1)
        shot("photo-picker")
        added.tap()
        let done = app.buttons["Done"]
        XCTAssert(done.waitForExistence(timeout: 5) && done.isEnabled, "picking a photo did not let the picker finish")
        done.tap()
        XCTAssert(app.buttons["Photo 2.jpg"].waitForExistence(timeout: 20), "the photo picked is not in the composer")
        composerField.tap()
        composerField.typeText("What is wrong with this page?")
        shot("composer-photos-typed")
        app.buttons["Send"].tap()
        XCTAssert(element(containing: "echo: What is wrong with this page?").waitForExistence(timeout: 30), "the Mac never answered the photos")
        let sent = app.buttons["Photo.jpg"]
        XCTAssert(sent.waitForExistence(timeout: 10), "the photo is not shown under the message")
        XCTAssertFalse(element(containing: "Sending").exists, "the message never settled")
        sleep(2)
        shot("message-photos-sent")
        sent.tap()
        XCTAssert(app.images["Photo.jpg"].waitForExistence(timeout: 15), "the Mac's copy of the photo did not arrive")
        shot("sent-photo-preview")
        app.navigationBars.buttons["Done"].firstMatch.tap()
    }

    /// A turn under way: Stop in the button's place; words typed make it Queue, the Mac's choice for a
    /// message mid-turn, with Steer and Stop a long press away, each saying what it does. Queued, the
    /// message waits on the Mac; Stop ends the turn and leaves it waiting, and it goes after the next.
    @MainActor
    func testC3_runningTurn() throws {
        let session = try XCTUnwrap(environment["RUNNING_SESSION"], "the script names the session it keeps working")
        launch(["-openSession", session])
        XCTAssert(element(containing: "Working").waitForExistence(timeout: 30), "the turn is not under way")
        dismissAccountPrompt()
        let stop = app.buttons["Stop"]
        XCTAssert(stop.waitForExistence(timeout: 10), "a turn under way has no Stop")
        sleep(2)
        shot("composer-stop")
        composerField.tap()
        composerField.typeText("Then check the toolbar")
        let queue = app.buttons["Queue"]
        XCTAssert(queue.waitForExistence(timeout: 5), "with words typed mid-turn the button does not queue")
        XCTAssertFalse(stop.exists, "Stop is still beside the button")
        shot("composer-queue")
        queue.press(forDuration: 1.2)
        // Each choice reads with the line under it that says what it does.
        let steer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Steer")).firstMatch
        XCTAssert(steer.waitForExistence(timeout: 5), "a long press does not offer Steer")
        shot("composer-queue-menu")
        XCTAssert(element(containing: "Stops the agent").exists, "the choices do not say what they do")
        dismissMenuInSession()
        queue.tap()
        XCTAssert(element(containing: "Then check the toolbar").waitForExistence(timeout: 10))
        XCTAssert(element(containing: "Queued on your Mac").waitForExistence(timeout: 15), "the Mac did not take the queued message")
        shot("message-queued")
        XCTAssert(stop.waitForExistence(timeout: 5), "with nothing typed the button is not Stop again")
        stop.tap()
        XCTAssert(element(containing: "Working").waitForNonExistence(timeout: 20), "Stop did not end the turn")
        XCTAssert(app.buttons["Send"].waitForExistence(timeout: 5), "with the turn over the button is not Send again")
        XCTAssert(element(containing: "Queued on your Mac").exists, "the queued message did not stay queued")
        shot("after-stop")
        composerField.typeText("Go on")
        app.buttons["Send"].tap()
        XCTAssert(element(containing: "echo: Then check the toolbar").waitForExistence(timeout: 30), "the queued message never went")
        XCTAssertFalse(element(containing: "Queued on your Mac").exists, "the queued message never settled")
        sleep(2)
        shot("queued-message-went")
    }

    /// The dark face, set on the Simulator by the script: the composer at rest, composing, its sheet and
    /// its mode menu.
    @MainActor
    func testC4_dark() throws {
        try composerTour(prefix: "dark")
    }

    /// The largest accessibility text size: the field grows, the chips scroll sideways, and the button
    /// keeps its place.
    @MainActor
    func testC5_largestText() throws {
        try composerTour(prefix: "ax", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    }

    /// Reduce Transparency, set on the Simulator by the script: the composer's glass goes solid.
    @MainActor
    func testC6_reduceTransparency() throws {
        try composerTour(prefix: "rt")
    }

    /// The composer at rest and composing, its settings sheet and its mode menu, each pictured under
    /// `prefix`.
    @MainActor
    private func composerTour(prefix: String, _ arguments: [String] = []) throws {
        try openComposer(arguments)
        shot("\(prefix)-composer-rest")
        composerField.tap()
        composerField.typeText("Read the composer's code first, then check the toolbar at every size")
        XCTAssert(modelChip.waitForExistence(timeout: 5))
        shot("\(prefix)-composer-typing")
        modelChip.tap()
        XCTAssert(app.navigationBars.buttons["Done"].waitForExistence(timeout: 10))
        sleep(1)
        shot("\(prefix)-settings-sheet")
        app.navigationBars.buttons["Done"].firstMatch.tap()
        XCTAssert(modeChip.waitForExistence(timeout: 10))
        modeChip.tap()
        sleep(1)
        shot("\(prefix)-mode-menu")
        dismissMenuInSession()
    }

    // MARK: - Helpers

    /// The menu in Home's bar: Review, Scheduled, Usage, then Settings.
    @MainActor
    private func openMenu() {
        app.navigationBars.buttons["home-menu"].tap()
        XCTAssert(app.buttons["Settings"].waitForExistence(timeout: 5), "the bar's menu did not open")
    }

    /// One of the pages in the bar's menu, which says what waits there after its name.
    @MainActor
    private func menuPage(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, "\(title), ")).firstMatch
    }

    @MainActor
    private func openSettings() {
        openMenu()
        app.buttons["Settings"].tap()
    }

    /// Quick Look's button that puts it away, once it is up. It can open on the picture alone, its bars
    /// hidden until the picture is pressed.
    @MainActor
    private func quickLookDone() -> XCUIElement {
        let done = app.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "Close"])).firstMatch
        if !done.waitForExistence(timeout: 15) { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        XCTAssert(done.waitForExistence(timeout: 10), "Quick Look did not open the picture")
        return done
    }

    /// Home's title, which opens the menu of profiles.
    @MainActor
    private var titleButton: XCUIElement {
        app.navigationBars.firstMatch.buttons.matching(NSPredicate(format: "identifier != 'home-menu' AND label != 'Reconnect'")).firstMatch
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

    /// A press on the transcript beside an open menu, which closes it: the bar's corner, where Home's
    /// menus close, is a session's way back.
    @MainActor
    private func dismissMenuInSession() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
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

    /// Opens the session the script names for the composer, once its Mac has said what its composer
    /// offers.
    @MainActor
    private func openComposer(_ arguments: [String] = []) throws {
        let session = try XCTUnwrap(environment["COMPOSER_SESSION"], "the script names the session to compose in")
        launch(["-openSession", session] + arguments)
        XCTAssert(app.buttons["Add photos or files"].waitForExistence(timeout: 30), "the composer offers no + (no session.options)")
        dismissAccountPrompt()
    }

    /// The Simulator's own prompt for its Apple Account's password, which lands over whatever is on
    /// screen soon after a launch: put away, as a person would.
    @MainActor
    private func dismissAccountPrompt() {
        let notNow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Not Now"]
        if notNow.waitForExistence(timeout: 3) { notNow.tap() }
        sleep(1)
    }

    @MainActor
    private var composerField: XCUIElement {
        app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
    }

    @MainActor
    private var modelChip: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model, ")).firstMatch
    }

    @MainActor
    private var modeChip: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Mode, ")).firstMatch
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
        pressClearOfTheBars(row)
    }

    /// Scrolls until an element's head is clear of the bars, and presses it there.
    @MainActor
    private func pressClearOfTheBars(_ element: XCUIElement) {
        let screen = app.windows.firstMatch.frame
        let clear = (screen.minY + 180)...(screen.maxY - 220)
        for _ in 0..<12 {
            let head = element.frame.minY + 24
            if clear.contains(head) { break }
            if head > clear.upperBound { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
        }
        element.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: element.frame.width / 2, dy: 24)).tap()
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

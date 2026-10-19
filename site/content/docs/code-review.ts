import { code, figure, h2, h3, note, p, page, steps, table, tip, ul } from "@/lib/docs-blocks"

export default page({
  slug: "code-review",
  title: "Code review",
  summary:
    "Review your own changes before they leave the session, and read, review and answer GitHub pull requests with any agent, signed in through your own GitHub CLI.",
  body: [
    h2("Your session's changes"),
    p(
      "**Show changes** (**View ▸ Show Changes**, `/diff`, or a click on the pill over the prompter that says what changed, such as **Changed 3 files**) opens **Changes** in the side panel: what changed in the session's checkout, in the same words, and under them the branch, any conflicts to resolve, the commits to push or pull, and the line counts.",
    ),
    ul(
      "When more than one kind of file changed, they're grouped as **Documents**, **Images**, **Media**, **Data**, **Code** and **Other files**. Each file says what happened to it, such as **New**, **Edited**, **Deleted** or **Renamed from …**.",
      "A picture shows before and after. A document, picture or media file opens rendered in Documents, and its chevron shows the lines that changed. A code file opens to its diff, where every line is marked with a sign as well as a colour.",
      "**Stage** and **Unstage** each file, or **Stage all** and **Unstage all**.",
      "Write a message and choose **Commit only**, or **Commit, push & PR** [[⌘↩]] to push the branch and open a pull request.",
      "**Request review** starts a read-only reviewer session over the checkout. Its verdict lands back in Changes.",
      "**History** lists the checkpoints taken in this checkout, to restore any of them (see [Sessions](/docs/sessions#undo-what-a-turn-changed)).",
    ),
    p("The card at the end of a turn that changed files has **Review**, which opens the changes of that turn alone. **Show all changes** goes back to the whole checkout."),

    h2("Pull requests"),
    figure(
      { part: "review" },
      "Code review with a pull request open, titled Stream the tokenizer instead of buffering its input. A Review by Fable 5.1 summarises two risks and lists three findings on src/tokenizer.ts, src/parser.ts and README.md, each with Add to review or Add to my comment. At the top, Review with Fable 5.1 and Submit review.",
      "A pull request reviewed by Fable 5.1: a summary and three findings, each one click from your review.",
    ),
    p(
      "**Code review** on the rail lists GitHub pull requests in three groups: **Authored by me**, **Needs my review** and **Needs my team's review**. Search the list, or paste a pull request's link into the search to open it. Pin one to keep it at the top.",
    ),
    p(
      "Realm reads GitHub through your own `gh`, the GitHub command line, signed in as you. Realm holds no GitHub token of its own and sees what `gh` sees.",
    ),
    h3("Set up GitHub"),
    p(
      "Until `gh` is installed and signed in, the page says what's missing and offers **Set up GitHub**, which opens a terminal with the command typed in for you to run. Coming back to the window checks again.",
    ),
    code("brew install gh && gh auth login", "What Set up GitHub types in, when gh is missing"),
    p("Press Return to run it and sign in when it asks. No Homebrew? `gh` is also at [cli.github.com](https://cli.github.com)."),

    h2("Review with an agent"),
    steps(
      "Open a pull request. **Summary** shows its description, checks, merge status, reviewers and comments; **Changes** shows its diff, with a file tree and one-column or side-by-side views.",
      "Press **Review with** and the model's name. The chevron beside it sets the model and **Tell the reviewer how to review your code**: instructions every review in your profile follows.",
      "The reviewer's summary and findings appear under **Review by** and the model. Each finding has **Add to review**, or **Add to my comment** when it isn't on a changed line. **Open session** shows the review's whole trace.",
      "Add line comments of your own on the **Changes** tab.",
      "Press **Submit review**, choose **Comment**, **Approve** or **Request changes**, write the review comment (it's required), and post it with [[⌘↩]].",
    ),
    note("GitHub lets the author of a pull request comment on it but not approve it or request changes, so on your own pull requests Approve and Request changes are greyed out."),

    h2("Ask about a pull request"),
    p(
      "The prompter at the foot of a pull request asks about it. The chip beside it, named for where it asks, chooses the space, and the first question starts a session there with the pull request attached. Its answers show beside the pull request, and **Hide answers** folds them away.",
    ),
    tip("Each review runs as a session in a space, named for its pull request, so the palette finds it again: type the repository or the number."),
  ],
})

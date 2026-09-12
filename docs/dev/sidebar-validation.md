# Sidebar gesture validation

A single-space sidebar must remain stationary under wheel or trackpad input. With multiple spaces,
minor diagonal jitter must not move the sidebar; deliberate horizontal swipes must still work.
Preserve vertical scrolling, edge behavior, cancellation, and momentum handling.

Run `node scripts/validate-sidebar.mjs gesture` for the focused regression suite. It uses the public
Vitest package without installing the desktop application's private icon dependencies. Every run
writes its result and candidate SHA under `.validation/`.

The state-machine suite is not complete UI proof. Build the candidate on macOS and check single and
multiple spaces using a real trackpad, including vertical scrolling, diagonal jitter, deliberate
swipes, cancellation, and momentum. Review dark and light modes. Do not test the previously installed
app and attribute that result to this candidate.

Record manual rendered evidence as JSON with `head` (the tested commit), `observer`, `checks`, and
`captures`. Checks are booleans named `singleSpaceStable`, `verticalScrollPreserved`,
`deliberateSwipeWorks`, `cancelAndMomentumSettle`, and `darkAndLightReviewed`. Each capture contains
`theme` (`dark` or `light`), `path`, and its hexadecimal SHA-256 in `sha256`; keep captures with the receipt.
Set `REALM_SIDEBAR_VISUAL_EVIDENCE` to that receipt and run
`node scripts/validate-sidebar.mjs visual`. Missing, stale, or incomplete evidence is blocked.

CI checks out the actual PR head and retains evidence even when checks fail. Its rendered gate stays
blocked without candidate-specific macOS evidence; a passing gesture suite does not make the PR
merge-ready. No CI step builds or replaces the user's installed Realm application.

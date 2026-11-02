/**
 * Realm's own repository on GitHub, and the two issue forms in its `.github/ISSUE_TEMPLATE`. The Help
 * menu and Settings ▸ General ▸ About both open these, so the two can never send a person to
 * different places; `realm-repo.test.ts` holds each URL to the form it names.
 */
export const REALM_REPO_URL = "https://github.com/31Carlton7/realm";

/** A new bug report with the running version already filled in: the one field a person filing it
 *  would otherwise have to go and look up. */
export const bugReportUrl = (version: string): string =>
  `${REALM_REPO_URL}/issues/new?template=bug.yml&version=${encodeURIComponent(version)}`;

export const FEATURE_REQUEST_URL = `${REALM_REPO_URL}/issues/new?template=feature.yml`;

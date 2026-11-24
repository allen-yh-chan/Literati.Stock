import path from "node:path";

/** Consumer-owned pre-PR checks file: free-form markdown the agent reads and follows (repo-root relative, posix). */
export const CONSUMER_PRE_PR_CHECKS_REL = ".devpro/pre-pr-checks.local.md";

/** Derived basename — MUST be the reserved consumer basename, not a second literal. */
export const CONSUMER_PRE_PR_CHECKS_BASENAME = path.posix.basename(CONSUMER_PRE_PR_CHECKS_REL);

/** The pre-markdown file name. It is no longer read; doctor warns when it is still present. */
export const CONSUMER_PRE_PR_CHECKS_LEGACY_REL = ".devpro/pre-pr-checks.local";

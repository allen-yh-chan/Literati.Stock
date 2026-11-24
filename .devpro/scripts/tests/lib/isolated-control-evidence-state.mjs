// Tests that gained a negative evidence lookup must own an isolated root even
// when their previous code path needed only remote sticky mocks.
//
// The merge gate's negative lookups also read local post-PR completion
// markers. Without an isolated dir they read the shared checkout state, where
// markers other tests or a live session are writing during a parallel run can
// surface as `marker_unreadable` and make a fixture block for the wrong reason.
// A test that needs a specific post-PR dir still sets the env var itself.
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ISOLATED_ENV_DIRS = [
  ["DEVPRO_SECOND_REVIEW_CONTROL_EVIDENCE_DIR", "second-review-negative-fence-"],
  ["DEVPRO_POST_PR_COMPLETION_STATE_DIR", "post-pr-completion-negative-fence-"],
];

const restore = ISOLATED_ENV_DIRS.map(([key, prefix]) => {
  const previous = process.env[key];
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  process.env[key] = root;
  return { key, previous, root };
});

after(() => {
  for (const { key, previous, root } of restore) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

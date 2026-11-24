// Fixtures that give a temporary git repository one positive governance identity, as classifyRepoIdentity and
// destinationIdentity (hooks/lib/operation-target.mjs) read it. A bare `git init` with no origin and no .gitmodules
// used to read as the rules source; it is no longer one, so a test that needs source-only behavior builds it here.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

const write = (root, rel, text = "x\n") => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

// The rules source: an origin named devpro-agent-rules plus the two maintained-corpus sentinels.
export function makeSourceIdentity(root, { origin = "https://github.com/devpro-tw/devpro-agent-rules.git" } = {}) {
  write(root, ".devpro/scripts/pre-pr-archive-gate.mjs", "// sentinel\n");
  write(root, ".devpro/agent-rules/rule-audit-playbook.md", "# sentinel\n");
  git(root, "remote", "add", "origin", origin);
}

// A consumer with installed rules (direct adoption evidence) and an origin of its own.
export function makeConsumerIdentity(root, { origin = "https://github.com/example-org/consumer-app.git" } = {}) {
  write(root, ".devpro-agent-rules/AGENTS.md", "# rules\n");
  write(root, ".devpro-agent-rules/.devpro/scripts/sync-agent-rules.mjs", "// sync\n");
  git(root, "remote", "add", "origin", origin);
}

// A repository that never adopted devpro: an origin of its own, a committed HEAD without any devpro trace.
export function makeNonDevproIdentity(root, { origin = "https://github.com/example-org/plain-app.git" } = {}) {
  write(root, "README.md", "plain\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-q", "-m", "init");
  if (origin) git(root, "remote", "add", "origin", origin);
}

// Make an existing fixture checkout read as the rules source without changing anything a gate diffs: the two
// sentinels are written to paths listed in the checkout's info/exclude (they exist on disk, git never sees them), and
// an origin is added only when there is none. A fixture whose origin is a local bare repository names that bare
// directory `devpro-agent-rules.git` (see SOURCE_BARE_NAME) so its origin URL reads as the source.
export const SOURCE_BARE_NAME = "devpro-agent-rules.git";
const SENTINELS = [".devpro/scripts/pre-pr-archive-gate.mjs", ".devpro/agent-rules/rule-audit-playbook.md"];

export function markSourceCheckout(root, { origin = "https://github.com/devpro-tw/devpro-agent-rules.git" } = {}) {
  const exclude = path.resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n${SENTINELS.map((rel) => `/${rel}`).join("\n")}\n`);
  for (const rel of SENTINELS) {
    if (!existsSync(path.join(root, rel))) write(root, rel, "// sentinel\n");
  }
  const remotes = git(root, "remote").split("\n").filter(Boolean);
  if (!remotes.includes("origin")) git(root, "remote", "add", "origin", origin);
}

// Undo markSourceCheckout's sentinels (the origin stays), so the checkout can carry consumer evidence instead.
export function unmarkSourceCheckout(root) {
  for (const rel of SENTINELS) rmSync(path.join(root, rel), { force: true });
}

// Make a fixture whose .gitmodules already declares `.devpro-agent-rules` read as a consumer: the two generated sync
// scripts are written to excluded paths (on disk, invisible to git), and an origin is added when there is none.
const GENERATED = [".devpro/scripts/sync-agent-rules.mjs", ".devpro/scripts/devpro-doctor.mjs"];

export function markConsumerCheckout(root, { origin = "https://github.com/example-org/consumer-app.git" } = {}) {
  unmarkSourceCheckout(root);
  const exclude = path.resolve(root, git(root, "rev-parse", "--git-path", "info/exclude"));
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, `\n${GENERATED.map((rel) => `/${rel}`).join("\n")}\n`);
  for (const rel of GENERATED) write(root, rel, "// generated\n");
  const remotes = git(root, "remote").split("\n").filter(Boolean);
  if (!remotes.includes("origin")) git(root, "remote", "add", "origin", origin);
}

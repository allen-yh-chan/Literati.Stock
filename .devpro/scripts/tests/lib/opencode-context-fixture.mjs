import { selectOpenCodeReviewerModel } from "../../lib/opencode-model-probe.mjs";
import path from "node:path";
import {
  OPENCODE_REVIEWER_CONTEXT_SCHEMA,
  canonicalOpenCodeLaunchConfig,
  canonicalOpenCodeLaunchScope,
} from "../../second-reviewer-cli-recipe-contract.mjs";
import {
  openCodeAgentNameForPolicy,
  resolveOpenCodeReviewerSelection,
  serializeOpenCodeLaunchConfig,
  sha256OfBytes,
} from "../../lib/opencode-reviewer.mjs";

// A Windows neutral cwd is drive-absolute (os.tmpdir() always is); `\tmp\...` would not count as absolute there.
export const OPENCODE_FIXTURE_NEUTRAL_CWD = process.platform === "win32"
  ? path.win32.join("C:\\", "tmp", "devpro-second-review-neutral-abc123")
  : path.join(path.sep, "tmp", "devpro-second-review-neutral-abc123");

// A canonical observability context for the deepseek/OpenCode reviewer. Every derived field
// (scope, launch digest) is computed through the production functions, so tests mutate one
// field at a time instead of re-implementing the contract.
export function buildOpenCodeContext({
  mode = "audit-only",
  generation = "v2",
  linkedIssue = "none",
  launchConfigPath = path.join(path.sep, "tmp", "attempt", "opencode-launch.json"),
  instructionFiles = [],
  env = {},
  mutate,
} = {}) {
  const probe = selectOpenCodeReviewerModel([{
    id: "deepseek-v4-pro", modelID: "deepseek-v4-pro", providerID: "deepseek", name: "DeepSeek V4 Pro",
    enabled: true, status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "max", settings: { reasoningEffort: "max" } }],
  }], { effort: "max", requested: env.DEVPRO_SECOND_REVIEWER_MODEL_OPENCODE });
  const selection = resolveOpenCodeReviewerSelection(env, probe);
  const toolPolicy = mode === "audit-only" ? "none" : "pr-sticky";
  const context = {
    mode,
    reviewer_family: "deepseek",
    linked_issue_context: linkedIssue,
    neutral_cwd_path: OPENCODE_FIXTURE_NEUTRAL_CWD,
    repository_slug: "example-org/example-repo",
    reviewer_model_selection: {
      requested: selection.selector,
      probe,
      source: selection.source,
      env_var: selection.env_var,
    },
  };
  const scope = canonicalOpenCodeLaunchScope(context);
  context.reviewer_opencode = {
    schema: OPENCODE_REVIEWER_CONTEXT_SCHEMA,
    cli_version: generation === "v2" ? "2.0.24" : "1.18.31",
    generation,
    selection,
    tool_policy: toolPolicy,
    agent_name: openCodeAgentNameForPolicy(toolPolicy),
    launch_config_path: launchConfigPath,
    launch_config_sha256: "0".repeat(64),
    launch_scope: { instruction_files: instructionFiles, ...scope },
  };
  const config = canonicalOpenCodeLaunchConfig(context, scope, instructionFiles.map((entry) => entry.path));
  context.reviewer_opencode.launch_config_sha256 = sha256OfBytes(
    Buffer.from(serializeOpenCodeLaunchConfig(config), "utf8")
  );
  if (mutate) mutate(context);
  return context;
}

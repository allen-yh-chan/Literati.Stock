/**
 * Frozen legacy-artifact allowlists and their ownership classifiers for the
 * 2-entry skill topology migration (design D5 of change
 * refactor-agent-skills-entry). This module holds ONLY frozen data and pure
 * classification functions — no I/O beyond read-only lstat/open/readlink/git
 * probes needed to classify a path, and it never mutates or deletes
 * anything itself. `sync-agent-rules.mjs` imports this module (one-way);
 * this module MUST NOT import sync-agent-rules.mjs (would create a cycle).
 *
 * ---------------------------------------------------------------------------
 * LEGACY_SKILL_ENTRY_LINKS — one-shot generator command (design D5):
 *
 *   for each ref in `git tag -l "production-v*"` plus base `3a455a97c`:
 *     git ls-tree -r <ref> -- .claude/skills .agents/skills
 *   keep only mode 120000 entries, read each blob with
 *   `git cat-file -p <blob>`, and aggregate the literal target strings by
 *   path across all refs.
 *
 * Result (verified 2026-09-26 against all 233 production-v* tags + base
 * 3a455a97c in the main checkout): 40 paths (20 names x two discovery
 * dirs), each with exactly ONE historical literal target. The 20 names are
 * the 18 renamed `dp-*` SSOT dirs (design D10) plus `cmux-surface-comms`
 * and `openspec-artifact-authoring` (whose SSOT dirs keep their name but
 * whose per-skill discovery LINK still retires under the 2-entry topology).
 * Deliberately EXCLUDES `dp-second-reviewer`, `dp-rule-audit` and
 * `dp-convergence-loop` — those three names are already owned by the
 * existing `LEGACY_SECOND_REVIEW_ARTIFACTS` /
 * `LEGACY_RULE_GOVERNANCE_SKILL_ARTIFACTS` allowlists in
 * sync-agent-rules.mjs; duplicating them here would race the new residue
 * check (which runs first in CHECK_STEPS/SYNC_STEPS) against those existing
 * checks/prunes.
 * ---------------------------------------------------------------------------
 * LEGACY_SKILL_PAYLOAD_FILES — one-shot generator command (design D5):
 * legacy-skill-names:begin legacy-payload-generator-doc
 *   for each ref in `git tag -l "production-v*"` plus base `3a455a97c`:
 *     git ls-tree -r <ref> -- <18 old dp-<x> SSOT dirs> \
 *       .devpro/agent-skills/autonomous-ai-agents \
 *       .devpro/agent-skills/documentation/design-doc-mermaid \
 *       .devpro/agent-skills/templates/SKILL.md
 * legacy-skill-names:end legacy-payload-generator-doc
 *   keep only mode 100644/100755 blob entries (drop 120000 symlinks and
 *   160000 gitlinks), aggregate blob ids by path across all refs.
 *
 * Result (verified 2026-09-26, same 234 refs): 31 distinct paths, 189
 * distinct (path, blob) pairs total — smaller than the ~214 pairs the
 * design estimated for the full `.devpro/agent-skills` history, consistent
 * with this being a strict legacy subset.
 * Re-run 2026-09-27 after the rebase onto `8100107ab` (decisions D2), adding
 * that merge-base as a ref: +4 pairs (193 total), same 31 paths. Re-run
 * 2026-09-28 after the rebase onto `5758d1f57` (decisions D12), adding that
 * merge-base as a ref: +2 pairs (195 total, both in the pre-pr skill), same 31
 * paths; the 40 entry-link literals are unchanged. Re-run again against the
 * final merge-base if main moves before merge.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

// legacy-skill-names:begin entry-links
export const LEGACY_SKILL_ENTRY_LINKS = Object.freeze(
  [
    { path: ".agents/skills/cmux-surface-comms", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/cmux-surface-comms"] },
    { path: ".agents/skills/dp-change", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-change"] },
    { path: ".agents/skills/dp-clarify", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-clarify"] },
    { path: ".agents/skills/dp-consumer-doctor", shippedTargets: ["../../.devpro/agent-skills/consumer/dp-consumer-doctor"] },
    { path: ".agents/skills/dp-cross-review", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-cross-review"] },
    { path: ".agents/skills/dp-init", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-init"] },
    { path: ".agents/skills/dp-knowledge-distill", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-knowledge-distill"] },
    { path: ".agents/skills/dp-knowledge-ingest", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-knowledge-ingest"] },
    { path: ".agents/skills/dp-load-plan", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-load-plan"] },
    { path: ".agents/skills/dp-pre-pr", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-pre-pr"] },
    { path: ".agents/skills/dp-recap-writer", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-recap-writer"] },
    { path: ".agents/skills/dp-release-runbook", shippedTargets: ["../../.devpro/agent-skills/release/dp-release-runbook"] },
    { path: ".agents/skills/dp-rule-governance", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-rule-governance"] },
    { path: ".agents/skills/dp-second-review", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-second-review"] },
    { path: ".agents/skills/dp-second-review-dogfood", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-second-review-dogfood"] },
    { path: ".agents/skills/dp-security-scan", shippedTargets: ["../../.devpro/agent-skills/security/dp-security-scan"] },
    { path: ".agents/skills/dp-setup-ci", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-setup-ci"] },
    { path: ".agents/skills/dp-sync-rules", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-sync-rules"] },
    { path: ".agents/skills/dp-workflows", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-workflows"] },
    { path: ".agents/skills/openspec-artifact-authoring", shippedTargets: ["../../.devpro/agent-skills/openspec/openspec-artifact-authoring"] },
    { path: ".claude/skills/cmux-surface-comms", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/cmux-surface-comms"] },
    { path: ".claude/skills/dp-change", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-change"] },
    { path: ".claude/skills/dp-clarify", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-clarify"] },
    { path: ".claude/skills/dp-consumer-doctor", shippedTargets: ["../../.devpro/agent-skills/consumer/dp-consumer-doctor"] },
    { path: ".claude/skills/dp-cross-review", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-cross-review"] },
    { path: ".claude/skills/dp-init", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-init"] },
    { path: ".claude/skills/dp-knowledge-distill", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-knowledge-distill"] },
    { path: ".claude/skills/dp-knowledge-ingest", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-knowledge-ingest"] },
    { path: ".claude/skills/dp-load-plan", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-load-plan"] },
    { path: ".claude/skills/dp-pre-pr", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-pre-pr"] },
    { path: ".claude/skills/dp-recap-writer", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-recap-writer"] },
    { path: ".claude/skills/dp-release-runbook", shippedTargets: ["../../.devpro/agent-skills/release/dp-release-runbook"] },
    { path: ".claude/skills/dp-rule-governance", shippedTargets: ["../../.devpro/agent-skills/rules-authoring/dp-rule-governance"] },
    { path: ".claude/skills/dp-second-review", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-second-review"] },
    { path: ".claude/skills/dp-second-review-dogfood", shippedTargets: ["../../.devpro/agent-skills/devpro-reviews/dp-second-review-dogfood"] },
    { path: ".claude/skills/dp-security-scan", shippedTargets: ["../../.devpro/agent-skills/security/dp-security-scan"] },
    { path: ".claude/skills/dp-setup-ci", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-setup-ci"] },
    { path: ".claude/skills/dp-sync-rules", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-sync-rules"] },
    { path: ".claude/skills/dp-workflows", shippedTargets: ["../../.devpro/agent-skills/devpro-workflows/dp-workflows"] },
    { path: ".claude/skills/openspec-artifact-authoring", shippedTargets: ["../../.devpro/agent-skills/openspec/openspec-artifact-authoring"] },
  ].map((entry) => Object.freeze({ path: entry.path, shippedTargets: Object.freeze([...entry.shippedTargets]) }))
);
// legacy-skill-names:end entry-links

// legacy-skill-names:begin payload-files
export const LEGACY_SKILL_PAYLOAD_FILES = Object.freeze(
  [
    { path: ".devpro/agent-skills/autonomous-ai-agents/claude-code/SKILL.md", blobIds: ["57f5147b7c83e7f829e6ffc280d76f950c14bbd4"] },
    { path: ".devpro/agent-skills/autonomous-ai-agents/codex/SKILL.md", blobIds: ["a796852b7547feba7069036d74bcd7e3f79b0eaf"] },
    { path: ".devpro/agent-skills/consumer/dp-consumer-doctor/SKILL.md", blobIds: ["69243fb5a2bccd802befb7e90d5668f501f54664", "6d485f3ff3761fc2f96e9fe670af6b419647b51a"] },
    { path: ".devpro/agent-skills/devpro-reviews/dp-cross-review/SKILL.md", blobIds: ["125aa31c1d91b1a3328a1ff3d96cc9e264f9b278", "19cae19a5a958924404255c5f72c8bf5b66d1d26", "1f6d548edcee31bc563e9f8ee8483ad30e243776", "20f2ad94e70c5527feecd360fefcefed6872e5b7", "2546ff3d95519039bbe48d979914492f539875dd", "39ec6fd0ae849bedd90ad86726790004efbc01c8", "5010de1499a56b745dc1144ce3b9d11a38689d69", "54449a2cea8db67554a03442655d27d03954e8d6", "663fc136459dbbc270a444764a3b180d471cb968", "7c24f9dad6c6db7f41db3aa321eb69bd66b0fcc4", "7dc15fb5a9bf010f1950f67ec5c98cd94a802749", "8fc6141e64a9a67f8f2a3e709d4289341e00b343", "a1912f26c7a6c03b18cc98dfc188027c647e0659", "c19a55073c5628a832482055904d8c7b39faf809", "c48b576659598d6cc249ab97fc3f5aa9c45d1917", "c61a7998c1ad8ebf5d147b08a07d745c0e3a1fce", "cff1a0e7a28c7723aa46b1da45be620a4b5f7c98", "d0d49134f461790eba35aa34fc742b2480e26766", "ee2aa9d17a0982ab4aa9170d68c316233751f884", "fd4cf6dd491f7bd7c1a2ec4d558e0c1501d7958d"] },
    { path: ".devpro/agent-skills/devpro-reviews/dp-cross-review/references/cli-invocation.md", blobIds: ["0cc080a223fe53aba488ecf897c2a9c4af52f331", "17ff6e44dbe9329d1525f356c1c4356642e58ef7", "3a71bc135528f06123b7759e3ae61bf2adc4c24a", "6b244b1c6c072fa481b6c527f98448506eab01a1", "7e7c8c16aaf72b0ec0654397a2cf266c30f031dd", "93797be19a154d79ef9f386b15890214230e75a1", "aeed2beec24c0227a8024f0783d2e856a620bbb9", "bbf068122447a8cb8fd5576778dd114470fd88b1", "df9f89accd00d6f50ea51a092686a76a80d847a1", "e5203441a0480e1d3b3839df8508e558bf23a0d6", "e672b0bb77df0e4b3214c8dda7cec6483e3b7a6a", "f50cc2c8e91a960486e654592513bc0525f37f27", "f83eafc87f026487fb3d4b5fba866b52d8f16cb6"] },
    { path: ".devpro/agent-skills/devpro-reviews/dp-cross-review/references/troubleshooting.md", blobIds: ["147daac349b1e3b4e7c28a3b12a587f225b20b32", "1537419766e997dd3eb80b7cb5ebc2df8907de9b", "3e66bb8b07acaa5b6300b4b895fd34a56db043a6", "8088c92172e7309142d1a44438825405599c3e8a", "d34e148583a6f3278d1aeea98a3ab5f8fb7a7310", "f17b5791f9cfc8a13ec62b272f1e60e143117303"] },
    { path: ".devpro/agent-skills/devpro-reviews/dp-second-review-dogfood/SKILL.md", blobIds: ["0d989eb08d41d4a193f7af58deb025998633e0e5", "2d26f631681c58f962f6963594de53cff7f0e2e0", "5e9b696f4b4d5fa209180f074579a4eaf15c1850", "94a3e6426f41603b6e7f227e10e892bfd4a26487", "da0775ab7639063c95accf19a2405d1e82b342f0", "dd3120ad918e6c7e77c30d1cfe56dfd35d5c132e"] },
    { path: ".devpro/agent-skills/devpro-reviews/dp-second-review/SKILL.md", blobIds: ["02932759ab7da7ffb3872bae6558e8559a3d17c3", "2b2e9c7b0ea57f0ad900644dfb275e3e9b07ed26", "301bef2b50f76ed1fcc5c2e801aef073e99fd819", "5c6ed86eae89f1afd5d60485f3299410c41fbb10", "5cb650b3c7adad05869f5ced2495a91482fd7541", "60404a1b23b9d1d8e367114fc004fcc8bf3aa41d", "708a4b5ff3b35698796b423f55a4bf1d9dcbbb65", "7587e6d74312d168ff1d8d9ae61e14bd3290f929", "83e3da13b5c72a2f94ffa3a72839ab0fcd504dfa", "849182c4013da79ea75ce8803d5a468d8f2ab517", "9513b7617bf19fc7989db667a1b8ea0e2bf9a8c3", "980c983481dad5ece790ca8fc875ab09d950993c", "9830628d11820ac84c9d18cc9691178ad1da5220", "a6d26f13cc03421d2e481887ec13da714ffff0eb", "aa46804268f5b029819e7c3069acb03233e47d0f", "b18badcb212005682d26c6e325d428288548f1f8", "c780692aabda3b45325629780d68c0f8a1db5d1a", "cb10df0da4b1b3f9e47c806f82783b45bd5bf2f5", "cf864e585bdbdebe2f896508633956d824a1cbd3", "e7953fcc923073e8729e740fe0e3aff31dc1bafb", "ea8a305e46026f155dae77aa63f1033fc52f8dde", "eca389dc5239d9375229e3669fe0a141b59c8428", "fcfcf4bcd42a024c6f97711d91106b5db1c517c2"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-change/SKILL.md", blobIds: ["126ef7fa57fe6f7e4167236e39ff312a0bcd11a2", "21deb5713bca19fb9a67c27d0c43638626a763b1", "247dbbd38fa425c2b32d5183a08304cf0c32ddf5", "3df1d4784e0dfd96a27da73a48629d483b556243", "400ff1aa3b269f7d3d8d26838112563e7f89c1c2", "49efe11af2bdb4894bdc8a53abef61e0b2e2f0e5", "4bf7528cb3f49faaa014aca0f55b60d8566ac6cf", "509571a6e9bff8cc6d1ccc0c1935c086a6e0a73b", "574403bcf94eb2036b1375b70ce262842f33f707", "63e5e10985d2f12b68a6e96751786341cd12f409", "6e510c4d36eb7c6715953de83acaeacd9dfb5b09", "7857a70cbeafd54216ace8d45cd630e6b0096409", "7cc189cb8537e0b5affe11045465a1ccc3e86f9d", "9a502e4635dbc03f0237f9dd993543620b9dc95b", "9f1af6953eff3ecf084ea47c2bd9a9095812ac43", "a22c097bf43a6453b59c7ef2c2dc0f9e047d20c9", "a64cd3eff359265bd8f3a70a7a2ce03136632700", "acf412a4ed076c83edb699a81becb88dc0e872b5", "afe8ab430636346794052c1898b587e695f23bba", "c5d3d7359e08afdfb550ee29b8b0621d36cfa693", "cb09195eb06b887b714af0b7be1af96df3e517bd", "d0698645a4659659458827940054938fde1aba92", "d404a1ccc005612cd1f0f1fc84734fe0a7b74b5c", "e2e1c750a22c9cf71d6317607b4f5353613c777d", "f1ac5d199f1165a42b6559fdd8a213f182f36049"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-clarify/SKILL.md", blobIds: ["2ca5d4ded29e0633018ff9070bf6ec08c46d835d", "7d33e0f6520235696f41ddefe1cb2e8ec62ef880", "8ffd7f811de03ceff8d213106694e4978ddc05fb", "c1b839b9c757787d18e610cde658f9193bd7b7c3"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-init/SKILL.md", blobIds: ["3b7bb3e58fadfba3da5c2f968e526dd6cd83d308", "aed39ae1974117aa7fce148944e4fcb354abf576"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-load-plan/SKILL.md", blobIds: ["21da08387548f552ea84d753eea28a55d76cd9f0"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-pre-pr/SKILL.md", blobIds: ["0df2275a1a595a04caf07ec472520e70c8c5558d", "140296004d7d0fc48a61b09832eb33bc5525b8cd", "2eb497633fbc4e7d06bf6f0c1f43e21b8300640e", "338c97e51dbf99847c1a8267c074e4627a0922ca", "3437974e0b6d057ad897757775afb04cd653352e", "40788ef9acdd26f0f65e6a650addcefc92e2bbf5", "41243c71501b8b12ca2fe9ffc3358af6b08065d8", "4cff78b58d8e3e9252aefe0f1f64625c62b5a680", "59ec8e7870a71abcdc2dec6736d4d2e6b660fbc7", "6c13e96dfde930d9b15c991e8775ff5081c22e41", "7c3088972032957998d6e1a33d52ee891e48bc97", "8475bad46b6e1b16c9d246d9b2ae1cd53b640128", "94a503330772772744dcce09aacb687e4e7ae218", "94d8230a740fa0a6f634cd96fca1fd23944459f8", "9ae008319511a631388274f08711ba631ceae152", "9e9129559cd63797f55085cc321ac0c047885124", "9fe9a39b8c81a275b7f0ddcacc24bc4483d041a1", "a4683829475a108e814d9bd68a1d4a73ab24b6fb", "af12e3a55753c78e6507ef6e3643ac9d5ec90186", "b4367b40f3eabe4b1d79e337ad9a46551c42065f", "c58e0d45b7aa0c0958eb01e11d3d19615b92cc55", "d877e07cc8352b8551e321145ce40a3d6b5108fd", "da94ccf8a1b2bc75a757690324dbcc898f2c6bf5", "df14e716bd47e630da6c2f031adffd304d5be3c0", "e5f940d3b97e529ff8451eda8b030aa314e1ba02", "ed259df32c250a5a95388dd3e2aade2c460aa341", "fb2b231e40b5f56d06264b0d6233db87f6e1e1de"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-pre-pr/references/subagent-dispatch-blocks.md", blobIds: ["0b37ecd973e040bbe563742ef5d3816ab47159f8", "1070574b844465d8e7fba2aad019525aecf216da", "1150e293a696df704d09d5b571480646d6f98a2d", "2a2a48425e86f355cffa0ded414513922d6f51bb", "39cc6728094d13d4e6778f0f73e65f23c5d86c99", "3d9fcd4afb1be7bfb53d9f7e647e1a6b89108e46", "434695f1302d52b6865f481272c01d87337dd3d7", "5e9b3e00e90f4754b7b53297e523044575566079", "67451159d9edaa9de56a6be1ab46fb89fb37d39c", "70fcfad81c84e5f6fd2b16941a38e307c974ea12", "71a96940233d8a81bd48efb9cd6314004b97df81", "7b41b5123b3f6f0d8838ad49d231bdf60b08cd57", "91807e7dee9ce565f416d4b91bd89b077eace7b5", "9f4fad8316efa23aeaba2ed67894bfeccf0181d9", "c13c565fee085fc319357804832be8e0677274a4", "c3271647e4024bfa73d702a08e8df884a822101c", "c80d87c49b090994483d4e84e611110d7c3fd7ad", "e53c5d8ef86b86eb0b59f0ae28b3ce58b5939590", "f16153b27033602555d6bb2a6525a266da2b3ec6"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-setup-ci/SKILL.md", blobIds: ["fcbf3d94abe49f318d5da6cea4d184953e11972a"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-setup-ci/references/codeql-component.md", blobIds: ["23f4fa93532a7a10961df8fe6553c3ef7f896d4b"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-setup-ci/references/discovery-mode.md", blobIds: ["b7a097247841b6fd47c96a8a9fbd204a206565cd"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-setup-ci/references/integration-component.md", blobIds: ["cc57a8eef9bc6c75f64418d10c20f8b86ec84fb7"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-sync-rules/SKILL.md", blobIds: ["23d151c17063419b5d803f0c2dea1ace64dc8fa8", "377391c70eec4938c952540c54e159483a1769ea", "6c6a8baa26d5f2764201f3f619fd7db51b6252af", "70972fdf4834153d6d2d5677bf67e4d30ec45107", "8928959d8605ac558fde6478cf409b8aa0371f66", "9e3f3ebdb8a2b1ef14d8040ad6bbb6b50e19249e", "c0efcab87bde79a7b96acfd847d1888052184e7a", "fa0d867a16e8228f3da791638101974df2a742c5"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-workflows/SKILL.md", blobIds: ["5ddfbd3f3e2ae29334a18cddfcf2f71e591c2330", "6325f95320639b9d2f5b13df5ce0a647a9909286", "76224e43f0dd23ecfb6946137e9cac270820ca48", "9381b8b4775ad205590f07841bd8785c13f947b2", "b98b91c50c495dcec87151dbdb0e29cca2876d21"] },
    { path: ".devpro/agent-skills/devpro-workflows/dp-workflows/agents/openai.yaml", blobIds: ["8986090fe39fdaa40ec99139de7768bd01f16d46"] },
    { path: ".devpro/agent-skills/documentation/design-doc-mermaid/SKILL.md", blobIds: ["67bfb1faf9ddaf9f77ca80764d6a91008a17668b", "a83bc73790a52be410acc8e8d88fed6e68e6edfd"] },
    { path: ".devpro/agent-skills/release/dp-release-runbook/SKILL.md", blobIds: ["425f5a08b8bd770cb82391c17447979a10e31361", "4b476e868c603d559f098b2bb60f96a2c1f8ba20", "56307d0b494d81842a26a6840a14cc349547f3fc", "717cbc3be984620b0e368d66e4b4453184cfe8ff", "a0d6417e832353cc4e952f1f75ae62aadf5c6ad9", "d330dd369c38554b5c1bf35d0d8824fe63292e41", "d6c074d1e7e8878cb0b4508409ad1f58991ba5a4"] },
    { path: ".devpro/agent-skills/rules-authoring/dp-knowledge-distill/SKILL.md", blobIds: ["02919846cb71c634af62363dcd88b0ec8b3b05ed"] },
    { path: ".devpro/agent-skills/rules-authoring/dp-knowledge-ingest/SKILL.md", blobIds: ["7c9cafb63f20f9e608f4fe1b55596496ae67cb91", "ba82d339897ec22d3a40cc2e33779d4da85367af", "ec9e02754f4f0b386c8bae8654a635389ff9b170"] },
    { path: ".devpro/agent-skills/rules-authoring/dp-recap-writer/SKILL.md", blobIds: ["b04eba238343d1c184cfc3808c555675c6d50079", "e34ecafbba421e15a529e24aa7bcab1ab3ae9362"] },
    { path: ".devpro/agent-skills/rules-authoring/dp-rule-governance/SKILL.md", blobIds: ["160b9ab3c8e7b92a4b610d28056152752773b310", "1b4e4fa1598efffe35199e45c95fef77b4bc97a7", "5d8eddcd55885cae78b96319d14b54bde23639fc", "df37ff5fb1447928c2d944453942eeb6d2ddc8e7", "eb79aa467e0ec0b0fa07067c22a3b20aaac47801", "f3c705234f405c6a69e7ec3fd7a4f869036e11c7"] },
    { path: ".devpro/agent-skills/security/dp-security-scan/SKILL.md", blobIds: ["5bebcc5a4ab509797b185423faac3513b477644b", "a19fd917ffd276b4e256b97229403c3b50c58b80"] },
    { path: ".devpro/agent-skills/security/dp-security-scan/references/sarif-report-flags.md", blobIds: ["8742c17e47988ce164c937dcb3ee2815405d3248"] },
    { path: ".devpro/agent-skills/security/dp-security-scan/references/workflow-templates.md", blobIds: ["d3e194c67899418d5e53ccd62a3516257f584695"] },
    { path: ".devpro/agent-skills/templates/SKILL.md", blobIds: ["8b162fd052e289b5e9ff422cf0636303226af57a", "e3712e45323e959cc72252dd15da20f32ef20dd9"] },
  ].map((entry) => Object.freeze({ path: entry.path, blobIds: Object.freeze([...entry.blobIds]) }))
);
// legacy-skill-names:end payload-files

function normalizeLinkTargetSeparators(target) {
  return target.split("\\").join("/");
}

/**
 * Walks the ancestor chain from `consumerRoot` down to (but not including)
 * the final segment of `relPath`, requiring every intermediate segment to
 * be a real (non-symlink) directory. Returns "absent" the moment an
 * ancestor is missing entirely (ENOENT) — nothing can exist beneath a
 * genuinely-missing directory, so this is a safe, warning-free no-op case
 * (e.g. a consumer that never had `.claude/skills`). Returns "unsafe" the
 * moment an ancestor exists but is NOT a real directory (a symlink, a
 * plain file, etc.) — this is the F-rase-r1-01/r1-02 danger case (an
 * ancestor could have been replaced by a symlink to elsewhere), so the
 * caller must fail closed to "not-owned" without inspecting the node
 * itself. Returns "ok" once every ancestor has been confirmed a real
 * directory (the caller may then safely lstat the final node).
 *
 * `inclusive` (design D8, T9 prune-ancestor finding) additionally requires
 * `relPath`'s own FINAL segment to be a real (non-symlink) directory —
 * used by callers whose "final node" IS a directory they intend to
 * `rmdir` (pruneLegacySkillPayload()'s empty-directory cleanup), where an
 * intermediate legacy skill directory could itself have been replaced by
 * a symlink pointing outside the catalog; without this, `fs.lstat`/
 * `fs.rmdir` on the joined path would transparently follow that symlink
 * and could delete a real, empty directory living entirely outside
 * `.devpro/agent-skills/`.
 */
export async function ancestorChainStatus(consumerRoot, relPath, { inclusive = false } = {}) {
  const segments = relPath.split("/");
  const boundary = inclusive ? segments.length : segments.length - 1;
  let cumulative = consumerRoot;
  for (let i = 0; i < boundary; i++) {
    cumulative = path.join(cumulative, segments[i]);
    const stats = await fs.lstat(cumulative).catch((error) => {
      if (error?.code === "ENOENT") return "enoent";
      throw error;
    });
    if (stats === "enoent") return "absent";
    if (!stats.isDirectory() || stats.isSymbolicLink()) return "unsafe";
  }
  return "ok";
}

function runGitAt(consumerRoot, args, options = {}) {
  return spawnSync("git", args, { cwd: consumerRoot, encoding: options.encoding });
}

/**
 * Reads the exact Git 120000 (symlink) blob bytes for `relPath` in the
 * consumer's own index, or null if the index has no such 120000 record.
 * Self-contained (does not import sync-agent-rules.mjs's private
 * equivalent) to avoid a circular import between the two modules.
 */
function readExactGitSymlinkBlobAt(consumerRoot, relPath) {
  const indexProbe = runGitAt(consumerRoot, ["ls-files", "--stage", "-z", "--", relPath], {
    encoding: "utf8",
  });
  if (indexProbe.error || indexProbe.status !== 0 || !indexProbe.stdout) return null;
  const match = /^(\d{6}) ([0-9a-f]+) 0\t([^\0]+)\0$/.exec(indexProbe.stdout);
  if (!match || match[3] !== relPath || match[1] !== "120000") return null;
  const blobProbe = runGitAt(consumerRoot, ["cat-file", "blob", `:${relPath}`], { encoding: null });
  if (blobProbe.error || blobProbe.status !== 0) return null;
  return blobProbe.stdout;
}

/**
 * Ownership classification for one LEGACY_SKILL_ENTRY_LINKS entry (design
 * D5, F-rase-r1-01). Returns one of:
 *   "absent"    — no residue at this path (nothing to warn about).
 *   "owned"     — a devpro-shipped legacy per-skill link, safe to prune.
 *   "not-owned" — something exists at this path but is not provably the
 *                 devpro-shipped literal (fail closed: keep, warn).
 */
export async function classifyLegacySkillEntryLink(consumerRoot, relPath) {
  const entry = LEGACY_SKILL_ENTRY_LINKS.find((candidate) => candidate.path === relPath);
  if (!entry) {
    throw new Error(`classifyLegacySkillEntryLink: ${relPath} is not in LEGACY_SKILL_ENTRY_LINKS`);
  }

  const ancestorStatus = await ancestorChainStatus(consumerRoot, relPath);
  if (ancestorStatus === "absent") return "absent";
  if (ancestorStatus === "unsafe") return "not-owned";

  const nodePath = path.join(consumerRoot, ...relPath.split("/"));
  const stats = await fs.lstat(nodePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (stats == null) return "absent";

  let literalTarget = null;
  if (stats.isSymbolicLink()) {
    literalTarget = await fs.readlink(nodePath).catch(() => null);
  } else if (stats.isFile()) {
    const blob = readExactGitSymlinkBlobAt(consumerRoot, relPath);
    if (blob != null) {
      const physical = await fs.readFile(nodePath).catch(() => null);
      if (physical != null && physical.equals(blob)) {
        literalTarget = blob.toString("utf8");
      }
    }
  }
  if (typeof literalTarget !== "string") return "not-owned";

  const normalized = normalizeLinkTargetSeparators(literalTarget);
  return entry.shippedTargets.includes(normalized) ? "owned" : "not-owned";
}

function gitBlobId(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function crlfToLf(bytes) {
  const text = bytes.toString("binary");
  return Buffer.from(text.replace(/\r\n/g, "\n"), "binary");
}

/**
 * Ownership classification for one LEGACY_SKILL_PAYLOAD_FILES entry
 * (design D5, F-rase-r1-02). Returns one of:
 *   "absent"     — no residue at this path.
 *   "owned"      — bytes match a known devpro-shipped historical blob id;
 *                  safe to delete.
 *   "modified"   — a regular file exists here but its bytes do not match
 *                  any known shipped blob id (consumer edited it).
 *   "not-owned"  — the node exists but is not a regular file (symlink,
 *                  directory, socket, etc.); never followed, never hashed.
 */
export async function classifyLegacySkillPayloadFile(consumerRoot, relPath) {
  const entry = LEGACY_SKILL_PAYLOAD_FILES.find((candidate) => candidate.path === relPath);
  if (!entry) {
    throw new Error(`classifyLegacySkillPayloadFile: ${relPath} is not in LEGACY_SKILL_PAYLOAD_FILES`);
  }

  const ancestorStatus = await ancestorChainStatus(consumerRoot, relPath);
  if (ancestorStatus === "absent") return "absent";
  if (ancestorStatus === "unsafe") return "not-owned";

  const nodePath = path.join(consumerRoot, ...relPath.split("/"));
  const lstats = await fs.lstat(nodePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (lstats == null) return "absent";
  if (!lstats.isFile() || lstats.isSymbolicLink()) return "not-owned";

  const openFlags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.open(nodePath, openFlags);
  } catch {
    return "not-owned";
  }
  try {
    const fstats = await handle.stat();
    if (!fstats.isFile() || fstats.dev !== lstats.dev || fstats.ino !== lstats.ino) {
      return "not-owned";
    }
    const bytes = await handle.readFile();
    const blobId = gitBlobId(bytes);
    if (entry.blobIds.includes(blobId)) return "owned";
    const normalizedBlobId = gitBlobId(crlfToLf(bytes));
    if (entry.blobIds.includes(normalizedBlobId)) return "owned";
    return "modified";
  } finally {
    await handle.close();
  }
}

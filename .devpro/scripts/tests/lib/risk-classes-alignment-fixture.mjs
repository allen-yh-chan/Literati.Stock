import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_RELATIVE =
  ".devpro/scripts/tests/fixtures/risk-classes-lint-classify-alignment-proposal-mini.md";

export function riskClassesAlignmentFixturePath(fromDir = dirname(fileURLToPath(import.meta.url))) {
  return join(fromDir, "..", "fixtures", "risk-classes-lint-classify-alignment-proposal-mini.md");
}

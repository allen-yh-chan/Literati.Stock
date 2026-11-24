/**
 * openspec-linter-cli.mjs
 *
 * Shared change-folder linter CLI skeleton. Per-file usage, extra-arg
 * parsing, violation printing, and pass logging stay in callbacks.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function runChangeFolderLinterCli({
  scriptName,
  usage,
  lint,
  printViolation,
  onPass,
  argv = process.argv,
  parseExtraArgs,
  requireExists = true,
  onError,
}) {
  const changeFolder = argv[2];
  if (!changeFolder) {
    console.error(usage);
    process.exit(1);
  }

  const extra = typeof parseExtraArgs === "function" ? (parseExtraArgs(argv) || {}) : {};
  const resolvedChangeFolder = resolve(changeFolder);

  if (requireExists && !existsSync(resolvedChangeFolder)) {
    console.error(`[${scriptName}] change folder not found: ${resolvedChangeFolder}`);
    process.exit(1);
  }

  const result = lint({ changeFolder: resolvedChangeFolder, ...extra });
  const ctx = { changeFolder, resolvedChangeFolder, extra };

  if (result.error) {
    if (typeof onError === "function") {
      onError(result, ctx);
    } else {
      console.error(`[${scriptName}] ${result.error}`);
    }
    process.exit(1);
  }

  if (!result.pass) {
    if (typeof printViolation === "function") {
      printViolation(result, ctx);
    }
    process.exit(1);
  }

  if (typeof onPass === "function") {
    onPass(result, ctx);
  }
  process.exit(0);
}

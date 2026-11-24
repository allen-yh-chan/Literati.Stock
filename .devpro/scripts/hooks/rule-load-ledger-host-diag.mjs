#!/usr/bin/env node
import { readStdin } from "./lib/stdin.mjs";
import { appendRuleLoadHostDiagnostic } from "./lib/rule-load-host-diagnostics.mjs";

async function main() {
  let payload;
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    process.exit(0);
  }
  appendRuleLoadHostDiagnostic(payload, { source: "host-diag" });
  process.exit(0);
}

main();

// Single copy of the `## <heading>` section reader. No imports on purpose, so a caller can take this helper without pulling in
// the packet validator that lib/pr-body-evidence-rules.mjs (the PR body rules, used by the handoff builder and the
// pre-create lint) depends on. That module hands these functions out as findExactH2Section and sectionBody.
// Every consumer takes its section helper from here; do not copy it back.

/** Raw match of one `## <heading>` section (group 1 is its body), `null` when the heading is absent. */
export function findH2Section(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(markdown ?? "").match(new RegExp(`^## ${escaped}[\\t ]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
}

/** Trimmed body of one `## <heading>` section, `""` when absent. */
export function h2SectionBody(markdown, heading) {
  const match = findH2Section(markdown, heading);
  return match?.[1]?.trim() ?? "";
}

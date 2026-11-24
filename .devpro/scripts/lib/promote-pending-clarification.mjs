/**
 * Idempotent merge of explore pending decided bullets into Clarification State text.
 * Not a user CLI gate — called from /devpro:change formalize recipe / unit tests.
 */

/**
 * @param {string} bullet
 * @returns {{ text: string, provenance: string|null }}
 */
export function splitProvenance(bullet) {
  const m = String(bullet).trim().match(/^(.*)\(provenance:\s*([^)]+)\)\s*$/i);
  if (!m) return { text: String(bullet).trim(), provenance: null };
  return { text: m[1].trim().replace(/[;\s]+$/, ''), provenance: m[2].trim() };
}

/**
 * @param {{ text: string, provenance: string|null }} a
 * @param {{ text: string, provenance: string|null }} b
 */
export function sameKey(a, b) {
  return a.text === b.text && a.provenance === b.provenance;
}

/**
 * @param {string[]} existingDecisions
 * @param {string[]} incomingDecided
 * @returns {{ decisions: string[], unresolved: string[], rejected: string[], aborted: boolean }}
 */
export function mergePromotableDecisions(existingDecisions, incomingDecided) {
  const unresolved = [];
  const rejected = [];
  const parsedExisting = existingDecisions.map(splitProvenance);
  /** @type {{ text: string, provenance: string }[]} */
  const acceptedIncoming = [];

  for (const raw of incomingDecided) {
    const p = splitProvenance(raw);
    if (!p.provenance) {
      rejected.push(raw);
      unresolved.push(`UNRESOLVED: missing-provenance — ${p.text}`);
      continue;
    }
    const conflictExisting = parsedExisting.find(
      (e) => e.text === p.text && e.provenance && e.provenance !== p.provenance,
    );
    const conflictIncoming = acceptedIncoming.find(
      (e) => e.text === p.text && e.provenance !== p.provenance,
    );
    if (conflictExisting || conflictIncoming) {
      unresolved.push(`UNRESOLVED: promote-provenance-conflict — ${p.text}`);
      // Fail-closed for the whole incoming batch: do not apply any merge from this call.
      return {
        decisions: [...existingDecisions],
        unresolved,
        rejected,
        aborted: true,
      };
    }
    if (!acceptedIncoming.some((e) => sameKey(e, p)) && !parsedExisting.some((e) => sameKey(e, p))) {
      acceptedIncoming.push({ text: p.text, provenance: p.provenance });
    }
  }

  const decisions = [...existingDecisions];
  const parsed = [...parsedExisting];
  for (const p of acceptedIncoming) {
    const line = `${p.text} (provenance: ${p.provenance})`;
    decisions.push(line);
    parsed.push(p);
  }
  return { decisions, unresolved, rejected, aborted: false };
}

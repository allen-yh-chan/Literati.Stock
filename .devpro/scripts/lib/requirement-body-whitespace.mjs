import { sha256Hex } from "./primitives.mjs";

/**
 * Non-delta promotion body compare (#2592 / D4 / F3).
 * Strip trailing horizontal whitespace per line; treat blank-line runs as
 * insignificant by dropping blank lines (makes 0↔1 and N-blank runs equivalent).
 * MUST NOT ignore indentation, tokens, punctuation, or SHALL/MUST wording.
 */
export function normalizeRequirementBodyWhitespace(body) {
  const lines = String(body).replaceAll("\r\n", "\n").split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  return lines.filter((line) => line !== "").join("\n");
}

export function requirementBodiesPromotionEqual(expectedBody, postBody, { exact }) {
  if (exact) return expectedBody === postBody;
  return normalizeRequirementBodyWhitespace(expectedBody)
    === normalizeRequirementBodyWhitespace(postBody);
}

/**
 * Mirror of derivePromotion's non-delta／delta body match policy.
 * Returns mismatched requirement titles (deduped, stable order).
 */
export function findUnmappedPromotionTitles({ expectedMap, postMap, deltaTitles }) {
  const mismatchedTitles = [];
  if (expectedMap.size !== postMap.size) {
    for (const title of postMap.keys()) {
      if (!expectedMap.has(title)) mismatchedTitles.push(title);
    }
    for (const title of expectedMap.keys()) {
      if (!postMap.has(title)) mismatchedTitles.push(title);
    }
  }
  for (const [title, body] of expectedMap) {
    const postBody = postMap.get(title);
    if (postBody === undefined) {
      mismatchedTitles.push(title);
      continue;
    }
    const exact = deltaTitles.has(title);
    if (!requirementBodiesPromotionEqual(body, postBody, { exact })) {
      mismatchedTitles.push(title);
    }
  }
  return [...new Set(mismatchedTitles)];
}

/** The seal's existing body parser; repair uses the same boundaries and bytes. */
export function parseRequirementBodies(text, label, delta = false, { includeBodySpans = false } = {}) {
  const lines = text.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n").split("\n");
  const entries = [];
  let mode = null;
  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^## (ADDED|MODIFIED|REMOVED) Requirements$/u);
    if (section) { mode = section[1]; continue; }
    const heading = lines[index].match(/^### Requirement: (.+)$/u);
    if (!heading) continue;
    if (delta && mode === null) throw new Error(`${label} requirement is outside a delta mode`);
    let end = index + 1;
    while (end < lines.length && !/^#{2,3} /u.test(lines[end])) end += 1;
    let bodyStart = index + 1;
    let bodyEnd = end;
    while (bodyStart < bodyEnd && lines[bodyStart] === "") bodyStart += 1;
    while (bodyEnd > bodyStart && lines[bodyEnd - 1] === "") bodyEnd -= 1;
    const body = lines.slice(bodyStart, bodyEnd).join("\n");
    if (body === "") throw new Error(`${label} requirement body is empty`);
    entries.push({
      title: heading[1], mode, body, body_digest: sha256Hex(Buffer.from(body)),
      ...(includeBodySpans ? { bodyStart, bodyEnd } : {}),
    });
    index = end - 1;
  }
  if (new Set(entries.map(({ title }) => title)).size !== entries.length) {
    throw new Error(`${label} has duplicate requirement titles`);
  }
  return entries;
}

/**
 * Plan only: restore reviewed delta bodies after CLI blank-line drift.
 * Non-empty lines must match exactly, including indentation/trailing spaces.
 * This does not make the drift sealable: only the restored exact body is.
 */
export function planArchiveDeltaBodyRepair({ deltaText, preCanonicalText, postCanonicalText, label }) {
  const deltas = parseRequirementBodies(deltaText, `${label} delta`, true);
  const pre = new Map(parseRequirementBodies(preCanonicalText, `${label} before`).map(item => [item.title, item.body]));
  const postEntries = parseRequirementBodies(postCanonicalText, label, false, { includeBodySpans: true });
  const post = new Map(postEntries.map(item => [item.title, item]));
  const expected = new Map(pre);
  const replacements = [];
  const nonBlankLines = body => body.split("\n").filter(line => line !== "").join("\n");
  for (const item of deltas) {
    const actual = post.get(item.title);
    const mismatch = () => { throw new Error(`${label}: ${item.mode} promotion title/body mismatch (${item.title})`); };
    if (item.mode === "REMOVED") {
      if (pre.get(item.title) !== item.body || actual !== undefined) mismatch();
      expected.delete(item.title);
      continue;
    }
    if ((item.mode === "ADDED" && pre.has(item.title)) || (item.mode === "MODIFIED" && !pre.has(item.title)) || !actual) mismatch();
    if (item.body !== actual.body) {
      if (nonBlankLines(item.body) !== nonBlankLines(actual.body)) mismatch();
      replacements.push({ ...actual, body: item.body, mode: item.mode });
    }
    expected.set(item.title, item.body);
  }
  // Parser spans are line indices; map them back to the physical source so
  // headings, non-delta bodies, mixed endings and a leading BOM stay untouched.
  const lines = postCanonicalText.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(Math.min(postCanonicalText.length, offsets.at(-1) + line.length + 1));
  let text = postCanonicalText;
  for (const item of [...replacements].sort((a, b) => b.bodyStart - a.bodyStart)) {
    const start = offsets[item.bodyStart];
    const end = offsets[item.bodyEnd];
    const eol = lines[item.bodyStart].endsWith("\r") ? "\r\n" : "\n";
    const ending = postCanonicalText.slice(start, end).endsWith("\n")
      ? (lines[item.bodyEnd - 1].endsWith("\r") ? "\r\n" : "\n") : "";
    text = text.slice(0, start) + item.body.replaceAll("\n", eol) + ending + text.slice(end);
  }
  const repaired = new Map(parseRequirementBodies(text, label).map(item => [item.title, item.body]));
  const mismatches = findUnmappedPromotionTitles({ expectedMap: expected, postMap: repaired, deltaTitles: new Set(deltas.map(item => item.title)) });
  if (mismatches.length > 0) throw new Error(`${label}: unmapped promotion change (${mismatches.join(", ")})`);
  return { text, repairs: replacements.map(({ title, mode }) => ({ title, mode })) };
}

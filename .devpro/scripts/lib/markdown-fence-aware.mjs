/**
 * Shared CommonMark-ish fence tracking + live H2 extraction.
 * Single implementation for risk-shape heading blocks, auth/clarification
 * H2 extractors, requirement-count ratchet helpers, and session-pending
 * parse/shape checks. No npm markdown parser.
 */

/**
 * @param {string} line
 * @returns {{ char: string, length: number, info: string } | null}
 */
export function fenceDelimiter(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!m) return null;
  const marker = m[2];
  const char = marker[0];
  const info = m[3];
  if (char === "`" && info.includes("`")) return null;
  return { char, length: marker.length, info };
}

/**
 * Closing fence: same char, run ≥ open length, and no info string.
 * @param {{ char: string, length: number, info: string }} delim
 * @param {{ char: string, length: number }} open
 */
export function closesFence(delim, open) {
  return delim.char === open.char && delim.length >= open.length && delim.info.trim() === "";
}

/**
 * @param {string} content
 * @returns {string}
 */
export function normaliseLineEndings(content) {
  return String(content ?? "").replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * @param {string} text
 * @returns {string}
 */
function blankSpan(text) {
  return text.replace(/[^\n]/gu, " ");
}

/**
 * @param {string} line
 * @returns {{ text: string, entersComment: boolean }}
 */
/** `'<!--'.length` — search for `-->` *after* the opener so `<!-->` stays unclosed (fail closed). */
const HTML_COMMENT_OPEN_LEN = 4;

function scanLiveLineForComments(line) {
  let text = "";
  let rest = line;
  for (;;) {
    const open = rest.indexOf("<!--");
    if (open === -1) return { text: text + rest, entersComment: false };
    text += rest.slice(0, open);
    const after = rest.slice(open);
    const close = after.indexOf("-->", HTML_COMMENT_OPEN_LEN);
    if (close === -1) return { text: text + blankSpan(after), entersComment: true };
    text += blankSpan(after.slice(0, close + 3));
    rest = after.slice(close + 3);
  }
}

/**
 * Blank fenced blocks and HTML comments; preserve line count and comment columns.
 * With `keepFences`, fenced blocks are kept verbatim and only HTML comments outside
 * fences are blanked, for readers that parse fence content but must ignore text the
 * rendered page hides. A fence marker inside a comment is comment text, not a fence.
 * @param {string} content
 * @param {{ keepFences?: boolean }} [options]
 * @returns {string}
 */
export function neutraliseInertMarkdown(content, { keepFences = false } = {}) {
  const lines = normaliseLineEndings(content).split("\n");
  /** @type {{ char: string, length: number } | null} */
  let openFence = null;
  let inComment = false;

  const out = lines.map((line) => {
    if (openFence !== null) {
      const delim = fenceDelimiter(line);
      if (delim && closesFence(delim, openFence)) openFence = null;
      return keepFences ? line : "";
    }
    if (inComment) {
      const close = line.indexOf("-->");
      if (close === -1) return blankSpan(line);
      inComment = false;
      const scanned = scanLiveLineForComments(line.slice(close + 3));
      inComment = scanned.entersComment;
      return blankSpan(line.slice(0, close + 3)) + scanned.text;
    }
    const delim = fenceDelimiter(line);
    if (delim) {
      openFence = delim;
      return keepFences ? line : "";
    }
    const scanned = scanLiveLineForComments(line);
    inComment = scanned.entersComment;
    return scanned.text;
  });

  return out.join("\n");
}

/**
 * @param {string} text
 * @param {(line: string, index: number, state: { inFence: boolean }) => void} onLine
 * @returns {string[]}
 */
export function forEachMarkdownLine(text, onLine) {
  const lines = normaliseLineEndings(text).split("\n");
  /** @type {{ char: string, length: number } | null} */
  let openFence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (openFence !== null) {
      const delim = fenceDelimiter(line);
      if (delim && closesFence(delim, openFence)) openFence = null;
      onLine(line, index, { inFence: true });
      continue;
    }
    const delim = fenceDelimiter(line);
    if (delim) {
      openFence = delim;
      onLine(line, index, { inFence: true });
      continue;
    }
    onLine(line, index, { inFence: false });
  }
  return lines;
}

/** @param {string} line @param {number} depth */
export function isAtxHeadingLine(line, depth) {
  const m = /^( {0,3})(#{1,6})(?:[\t ]+|$)(.*)$/u.exec(line);
  if (!m) return false;
  return m[2].length === depth;
}

/**
 * Exact H2 match within 0–3 indent. Allows flexible `##` / title whitespace
 * (same contract as historical `^##[\t ]+title[\t ]*$` extractors) and an
 * optional trailing `#` close run.
 * @param {string} line
 * @param {string} heading e.g. `## Requirement Ledger` or title-only callers
 *   that already prefixed `## `
 */
export function isExactH2Heading(line, heading) {
  const live = /^( {0,3})##[\t ]+(.+?)[\t ]*(?:#+[\t ]*)?$/u.exec(line);
  if (!live) return false;
  const wantRaw = heading.startsWith("##")
    ? heading
    : `## ${heading}`;
  const want = /^##[\t ]+(.+?)[\t ]*(?:#+[\t ]*)?$/u.exec(wantRaw);
  if (!want) return false;
  return live[2] === want[1];
}

/**
 * Bodies of each live exact H2 `heading` to the next live H2 or H1 (or EOF).
 * Fence-internal headings neither open nor close; fence body lines are kept
 * when the block is already open (risk-shape / digest), and are empty when the
 * caller first ran `neutraliseInertMarkdown` (ratchet path).
 *
 * @param {string} text
 * @param {string} heading
 * @returns {{ count: number, bodies: string[] }}
 */
export function extractExactH2Bodies(text, heading) {
  const bodies = [];
  /** @type {string[] | null} */
  let current = null;
  forEachMarkdownLine(text, (line, _index, { inFence }) => {
    if (inFence) {
      if (current !== null) current.push(line);
      return;
    }
    if (isExactH2Heading(line, heading)) {
      if (current !== null) bodies.push(current.join("\n"));
      current = [];
      return;
    }
    if (current !== null) {
      if (isAtxHeadingLine(line, 2) || isAtxHeadingLine(line, 1)) {
        bodies.push(current.join("\n"));
        current = null;
        return;
      }
      current.push(line);
    }
  });
  if (current !== null) bodies.push(current.join("\n"));
  return { count: bodies.length, bodies };
}

/**
 * First live exact H2 section body for `headingTitle` (with or without `## `).
 * @param {string} content
 * @param {string} headingTitle
 */
export function extractLiveH2Section(content, headingTitle) {
  const heading = headingTitle.startsWith("## ") ? headingTitle : `## ${headingTitle}`;
  const { bodies } = extractExactH2Bodies(content, heading);
  return bodies[0] ?? "";
}

/**
 * @param {string} md
 * @param {string} headingTitle without or with `## `
 */
export function countLiveH2Sections(md, headingTitle) {
  const heading = headingTitle.startsWith("## ") ? headingTitle : `## ${headingTitle}`;
  return extractExactH2Bodies(md, heading).count;
}

/**
 * Span from the sole live `heading` line through the line before the next live H2
 * (or EOF). When `endHeading` is set, that exact live line is the exclusive end.
 *
 * @param {string} text
 * @param {string} heading
 * @param {{ endHeading?: string | null }} [opts]
 * @returns {{ start: number, end: number, lines: string[] } | null}
 */
export function findExactHeadingSpan(text, heading, { endHeading = null } = {}) {
  const lines = normaliseLineEndings(text).split("\n");
  /** @type {number[]} */
  const starts = [];
  /** @type {number[]} */
  const endStarts = [];
  forEachMarkdownLine(lines.join("\n"), (line, index, { inFence }) => {
    if (inFence) return;
    if (line === heading) starts.push(index);
    if (endHeading !== null && line === endHeading) endStarts.push(index);
  });
  if (starts.length !== 1) return null;
  const start = starts[0];
  if (endHeading !== null) {
    if (endStarts.length !== 1 || endStarts[0] <= start) return null;
    return { start, end: endStarts[0], lines };
  }
  let end = lines.length;
  /** @type {{ char: string, length: number } | null} */
  let openFence = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (openFence !== null) {
      const delim = fenceDelimiter(line);
      if (delim && closesFence(delim, openFence)) openFence = null;
      continue;
    }
    const delim = fenceDelimiter(line);
    if (delim) {
      openFence = delim;
      continue;
    }
    if (/^## (?!#)/u.test(line)) {
      end = index;
      break;
    }
  }
  return { start, end, lines };
}

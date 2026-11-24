import {
  closesFence,
  fenceDelimiter,
  forEachMarkdownLine,
} from "./markdown-fence-aware.mjs";

/** Match a `## ` (exactly H2) heading line — the pending-section boundary. */
export function isPendingSectionHeading(line) {
  // Only `## ` (H2) opens a pending section — that is the pending unit in
  // `notes/session-pending.md`. A `# ` H1 is the document title (never a
  // pending), and `### `+ deeper headings are structural sub-parts INSIDE a
  // pending (e.g. `### 根因與證據（非獨立條目）`), not separate pendings; they are
  // absorbed as section content, not treated as a new block. Matching `### `+
  // here would wrongly split one pending into fieldless sub-blocks and false-
  // report each descriptive sub-heading as missing all three fields.
  return /^##\s/.test(line);
}

/**
 * Parse pending blocks from a text chunk, honouring the actual
 * `notes/session-pending.md` structure.
 *
 * Two shapes are recognised:
 *
 *  1. Heading section (the real session-pending.md shape): a `## ` (exactly H2)
 *     heading whose body is a FLAT list of non-indented `- `/`* ` field lines.
 *     The WHOLE section — the heading line plus every field bullet under it,
 *     up to the next `## ` heading, a section-closing `# ` H1, or EOF — is ONE
 *     block, because its sibling
 *     bullets are the pending's fields, not separate pending entries. (Before
 *     this, every flat `- ` line opened its own block, so one section split into
 *     N single-field blocks and every field line false-reported as missing two
 *     fields.) A `## ` heading with NO field bullets still forms one block, so a
 *     fieldless pending is reported as incomplete rather than silently skipped.
 *
 *  2. Bare top-level list item (legacy shape, no governing heading): a `- ` or
 *     `* ` line plus its indented continuation lines. Either bullet header opens
 *     a new block; blank lines between header and its indented continuation
 *     lines are absorbed (markdown loose-list); a non-blank non-indented line
 *     closes it.
 *
 * Fence-aware: lines inside an open backtick/tilde fence never open a section
 * or a legacy bullet block (shared SM with markdown-fence-aware.mjs).
 *
 * Heading depth is deliberate: only `## ` (H2) opens a pending section (the
 * pending unit). `# ` (H1) is the document title and never a pending, but a
 * mid-document H1 CLOSES the current section so a following item starts fresh.
 * `### `+ deeper headings are structural sub-parts INSIDE a pending and are
 * absorbed as section content, not treated as new blocks. Returns an array of
 * blocks, each being an array of the raw line strings.
 */
export function parseListItemBlocks(text) {
  if (!text) return [];
  const blocks = [];
  let current = null;
  let pendingBlanks = [];
  let inHeadingSection = false;
  const isLegacyBullet = (line) => line.startsWith("- ") || line.startsWith("* ");

  const flushCurrent = () => {
    if (current !== null) {
      blocks.push(current);
      current = null;
    }
    pendingBlanks = [];
  };

  forEachMarkdownLine(text, (line, _index, { inFence }) => {
    if (inFence) {
      if (current !== null) {
        for (const blank of pendingBlanks) current.push(blank);
        pendingBlanks = [];
        current.push(line);
      }
      return;
    }
    if (isPendingSectionHeading(line)) {
      flushCurrent();
      inHeadingSection = true;
      current = [line];
    } else if (/^#\s/.test(line)) {
      flushCurrent();
      inHeadingSection = false;
    } else if (isLegacyBullet(line)) {
      if (inHeadingSection && current !== null) {
        for (const blank of pendingBlanks) current.push(blank);
        pendingBlanks = [];
        current.push(line);
      } else {
        if (current !== null) blocks.push(current);
        pendingBlanks = [];
        current = [line];
      }
    } else if (line.length === 0 || line.trim() === "") {
      if (current !== null) {
        pendingBlanks.push(line);
      }
    } else if (current !== null && (line[0] === " " || line[0] === "\t")) {
      for (const blank of pendingBlanks) current.push(blank);
      pendingBlanks = [];
      current.push(line);
    } else if (inHeadingSection) {
      if (current !== null) {
        for (const blank of pendingBlanks) current.push(blank);
        pendingBlanks = [];
        current.push(line);
      }
    } else {
      flushCurrent();
    }
  });
  if (current !== null) blocks.push(current);
  return blocks;
}

/**
 * Index-tracking variant of parseListItemBlocks for claim/cleanup consumers.
 * Same H2 + legacy top-level bullet block boundaries; also accepts legacy `* `
 * top-level bullets (claim helper historical grammar). Each block is
 * `{ start, end, lines }` with `end` exclusive.
 */
export function parseBlocks(content) {
  const text = content == null ? "" : String(content);
  const lines = text.split("\n");
  const blocks = [];
  let current = null;
  let pendingBlanks = [];
  let pendingBlankStarts = [];
  let inHeadingSection = false;

  const isLegacyBullet = (line) => line.startsWith("- ") || line.startsWith("* ");

  const flushCurrent = (end) => {
    if (current !== null) {
      current.end = end;
      blocks.push(current);
      current = null;
    }
    pendingBlanks = [];
    pendingBlankStarts = [];
  };

  /** @type {{ char: string, length: number } | null} */
  let openFence = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (openFence !== null) {
      const delim = fenceDelimiter(line);
      if (delim && closesFence(delim, openFence)) openFence = null;
      if (current !== null) {
        for (let i = 0; i < pendingBlanks.length; i++) {
          current.lines.push(pendingBlanks[i]);
        }
        pendingBlanks = [];
        pendingBlankStarts = [];
        current.lines.push(line);
      }
      continue;
    }
    const delim = fenceDelimiter(line);
    if (delim) {
      openFence = delim;
      if (current !== null) {
        for (let i = 0; i < pendingBlanks.length; i++) {
          current.lines.push(pendingBlanks[i]);
        }
        pendingBlanks = [];
        pendingBlankStarts = [];
        current.lines.push(line);
      }
      continue;
    }
    if (isPendingSectionHeading(line)) {
      flushCurrent(lineIndex);
      inHeadingSection = true;
      current = { start: lineIndex, end: lines.length, lines: [line] };
    } else if (/^#\s/.test(line)) {
      flushCurrent(lineIndex);
      inHeadingSection = false;
    } else if (isLegacyBullet(line)) {
      if (inHeadingSection && current !== null) {
        for (let i = 0; i < pendingBlanks.length; i++) {
          current.lines.push(pendingBlanks[i]);
        }
        pendingBlanks = [];
        pendingBlankStarts = [];
        current.lines.push(line);
      } else {
        if (current !== null) {
          current.end = lineIndex;
          blocks.push(current);
        }
        pendingBlanks = [];
        pendingBlankStarts = [];
        current = { start: lineIndex, end: lines.length, lines: [line] };
      }
    } else if (line.length === 0 || line.trim() === "") {
      if (current !== null) {
        pendingBlanks.push(line);
        pendingBlankStarts.push(lineIndex);
      }
    } else if (current !== null && (line[0] === " " || line[0] === "\t")) {
      for (let i = 0; i < pendingBlanks.length; i++) {
        current.lines.push(pendingBlanks[i]);
      }
      pendingBlanks = [];
      pendingBlankStarts = [];
      current.lines.push(line);
    } else if (inHeadingSection) {
      if (current !== null) {
        for (let i = 0; i < pendingBlanks.length; i++) {
          current.lines.push(pendingBlanks[i]);
        }
        pendingBlanks = [];
        pendingBlankStarts = [];
        current.lines.push(line);
      }
    } else {
      const end = pendingBlankStarts.length > 0 ? pendingBlankStarts[0] : lineIndex;
      flushCurrent(end);
    }
  }
  if (current !== null) {
    const end =
      pendingBlankStarts.length > 0 ? pendingBlankStarts[0] : lines.length;
    current.end = end;
    blocks.push(current);
  }
  return { lines, blocks };
}

/**
 * Whole-file shape checker: the 1-based line numbers of every live column-0
 * `- ` / `* ` line, or none at all when the content has not adopted the `## `
 * convention. Fenced bullets are ignored (shared fence SM).
 *
 * @param {string} content
 * @returns {number[]} 1-based line numbers, ascending; empty when out of scope
 */
export function findSessionPendingShapeViolations(content) {
  const text = content == null ? "" : String(content);
  let hasLiveH2 = false;
  forEachMarkdownLine(text, (line, _index, { inFence }) => {
    if (!inFence && isPendingSectionHeading(line)) hasLiveH2 = true;
  });
  if (!hasLiveH2) return [];
  const violations = [];
  forEachMarkdownLine(text, (line, index, { inFence }) => {
    if (inFence) return;
    if (line.startsWith("- ") || line.startsWith("* ")) violations.push(index + 1);
  });
  return violations;
}

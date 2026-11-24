const DECLARATION_LINE_RE =
  /^[ \t]*(?:>[ \t]*)?(?:Load-chain(?:[ \t]*(?:\([^()\r\n]+\)|（[^（）\r\n]+）))?|\*\*Load-chain\*\*)[ \t]*[:：][ \t]*(?<body>.*)$/;

const TARGET_RE = /`([^`\r\n]+\.md)`/g;

function scanHtmlComments(text, inComment) {
  const visible = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (inComment) {
      const close = text.indexOf('-->', cursor);
      if (close === -1) return { visible: visible.join('\n'), inComment: true };
      cursor = close + 3;
      inComment = false;
      continue;
    }

    const open = text.indexOf('<!--', cursor);
    if (open === -1) {
      visible.push(text.slice(cursor));
      break;
    }

    visible.push(text.slice(cursor, open));
    cursor = open + 4;
    inComment = true;
  }

  return { visible: visible.join('\n'), inComment };
}

function openFence(line) {
  const content = line.replace(/^[ \t]{0,3}/, '');
  const run = content.match(/^(`+|~+)/)?.[0];
  if (!run || run.length < 3) return null;
  if (run[0] === '`' && content.slice(run.length).includes('`')) return null;
  return { marker: run[0], length: run.length };
}

function isFenceClose(line, fence) {
  const content = line.replace(/^[ \t]{0,3}/, '');
  const run = content.match(/^(`+|~+)/)?.[0];
  return Boolean(
    run &&
    run[0] === fence.marker &&
    run.length >= fence.length &&
    /^[ \t]*$/.test(content.slice(run.length))
  );
}

/**
 * Return the raw same-line Markdown references declared by explicit
 * Load-chain labels. Root/path/wildcard resolution remains caller-owned.
 */
export function extractDeclaredLoadChainRefs(markdown) {
  const refs = [];
  const source = String(markdown ?? '');
  let fence = null;
  let inHtmlComment = false;

  for (const rawLine of source.split(/\r?\n/)) {
    if (fence) {
      if (isFenceClose(rawLine, fence)) fence = null;
      continue;
    }

    if (inHtmlComment) {
      inHtmlComment = scanHtmlComments(rawLine, true).inComment;
      continue;
    }

    const openedFence = openFence(rawLine);
    if (openedFence) {
      fence = openedFence;
      continue;
    }

    const declaration = rawLine.match(DECLARATION_LINE_RE);
    const scannedLine = scanHtmlComments(rawLine, false);
    inHtmlComment = scannedLine.inComment;
    if (!declaration) continue;

    const visibleBody = scanHtmlComments(declaration.groups.body, false).visible;
    for (const target of visibleBody.matchAll(TARGET_RE)) {
      refs.push(target[1]);
    }
  }

  return refs;
}

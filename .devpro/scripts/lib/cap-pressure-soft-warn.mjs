/**
 * Soft-warn emitter for ordinary-path rule-token over-cap.
 * Paths are JSON-encoded (single-line; escapes newline/control bytes).
 * Aggregate stderr body is byte-capped with truncation metadata.
 */

export const CAP_PRESSURE_SOFT_WARN_TOP_N = 10;
export const CAP_PRESSURE_SOFT_WARN_MAX_BYTES = 2048;
export const CAP_PRESSURE_SOFT_WARN_META_RESERVE = 160;

function parseCanonicalNonNegativeInteger(token) {
  if (!/^(?:0|[1-9]\d*)$/u.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

function decodeExactUtf8(value) {
  if (typeof value === 'string') {
    return { text: value, bytes: Buffer.from(value, 'utf8') };
  }
  if (!Buffer.isBuffer(value)) return null;
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) return null;
  return { text, bytes: value };
}

/**
 * Accept only one complete canonical cap-pressure soft-warning body.
 * Any unrelated stderr, malformed metadata, invalid UTF-8, or non-finite
 * utilization fails closed.
 *
 * @param {string|Buffer} value
 */
export function isCanonicalCapPressureSoftWarn(value) {
  const decoded = decodeExactUtf8(value);
  if (!decoded || decoded.bytes.length === 0
    || decoded.bytes.length > CAP_PRESSURE_SOFT_WARN_MAX_BYTES
    || !decoded.text.endsWith('\n')) return false;

  const lines = decoded.text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) return false;

  const aggregate = lines[0];
  const completeMatch = /^soft-warn cap-pressure=over count=(\d+) showing=(\d+)$/u.exec(aggregate);
  const truncatedMatch = /^soft-warn cap-pressure=over count=(\d+) showing=(\d+) truncated=true omitted=(\d+) bytes=(\d+)$/u.exec(aggregate);
  const match = completeMatch ?? truncatedMatch;
  if (!match) return false;

  const count = parseCanonicalNonNegativeInteger(match[1]);
  const showing = parseCanonicalNonNegativeInteger(match[2]);
  if (count === null || showing === null || count < 1
    || showing > CAP_PRESSURE_SOFT_WARN_TOP_N
    || showing > count
    || lines.length !== showing + 1) return false;

  const aggregateLfIndex = decoded.bytes.indexOf(0x0a);
  if (aggregateLfIndex < 0) return false;
  const actualPathBytes = decoded.bytes.subarray(aggregateLfIndex + 1).length;
  if (actualPathBytes > CAP_PRESSURE_SOFT_WARN_MAX_BYTES - CAP_PRESSURE_SOFT_WARN_META_RESERVE) {
    return false;
  }

  if (truncatedMatch) {
    const omitted = parseCanonicalNonNegativeInteger(match[3]);
    const declaredPathBytes = parseCanonicalNonNegativeInteger(match[4]);
    if (omitted === null || declaredPathBytes === null || omitted < 1
      || count - showing !== omitted) return false;
    if (declaredPathBytes !== actualPathBytes) return false;
  } else if (count !== showing) {
    return false;
  }

  const pathPrefix = 'soft-warn cap-pressure=over path=';
  const utilizationSeparator = ' utilization=';
  for (const line of lines.slice(1)) {
    if (!line.startsWith(pathPrefix)) return false;
    const separatorIndex = line.lastIndexOf(utilizationSeparator);
    if (separatorIndex <= pathPrefix.length) return false;

    const pathToken = line.slice(pathPrefix.length, separatorIndex);
    let repoPath;
    try {
      repoPath = JSON.parse(pathToken);
    } catch {
      return false;
    }
    if (typeof repoPath !== 'string' || JSON.stringify(repoPath) !== pathToken) return false;

    const utilizationToken = line.slice(separatorIndex + utilizationSeparator.length);
    const utilization = Number(utilizationToken);
    if (!Number.isFinite(utilization) || utilization <= 100
      || String(utilization) !== utilizationToken) return false;
  }

  return true;
}

/** Encode repo path as one JSON string (escapes newline/control bytes). */
export function formatCapPressurePath(repoPath) {
  return JSON.stringify(String(repoPath ?? ''));
}

/**
 * @param {Array<{ path: string, utilization: number|null|undefined }>} files
 * @param {(chunk: string) => void} [write]
 */
export function emitCapPressureSoftWarn(files, write = (chunk) => process.stderr.write(chunk)) {
  // utilization is percent of cap; ratio > 1 ≡ utilization > 100 ≡ actual > cap.
  const over = files
    .filter((file) => file.utilization != null && file.utilization > 100)
    .sort((a, b) => b.utilization - a.utilization || String(a.path).localeCompare(String(b.path)));
  if (over.length === 0) return;

  const candidates = over.slice(0, CAP_PRESSURE_SOFT_WARN_TOP_N);
  const pathLines = [];
  let pathBytes = 0;
  let budget = CAP_PRESSURE_SOFT_WARN_MAX_BYTES - CAP_PRESSURE_SOFT_WARN_META_RESERVE;
  for (const file of candidates) {
    const utilization = Number(file.utilization);
    const line =
      `soft-warn cap-pressure=over path=${formatCapPressurePath(file.path)} ` +
      `utilization=${Number.isFinite(utilization) ? utilization : 'invalid'}\n`;
    const n = Buffer.byteLength(line, 'utf8');
    if (n > budget) break;
    pathLines.push(line);
    budget -= n;
    pathBytes += n;
  }

  const showing = pathLines.length;
  const omitted = over.length - showing;
  const truncated = omitted > 0;
  write(
    `soft-warn cap-pressure=over count=${over.length} showing=${showing}` +
      (truncated ? ` truncated=true omitted=${omitted} bytes=${pathBytes}` : '') +
      '\n'
  );
  for (const line of pathLines) write(line);
}

/**
 * Shared detector for proposal Touch/file-list table rows that name a change's
 * own pre-archive active path (`openspec/changes/<name>/…` outside archive/).
 */
/**
 * @param {string} text
 * @param {string} changeName bare change name (no date prefix)
 * @returns {number[]} 1-based row numbers
 */
export function findOwnActivePathRows(text, changeName) {
  const safe = String(changeName ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = String(text ?? '').split(/\r?\n/u);
  const re = new RegExp(`^\\s*\\|.*openspec/changes/${safe}/(?!archive)`, 'u');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

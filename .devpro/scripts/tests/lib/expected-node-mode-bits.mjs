/**
 * Node reports 0o666 for ordinary writable files and directories on Windows;
 * POSIX permission/execute bits are not represented by Stats.mode there.
 * Windows access is governed by the filesystem ACL, not this mode field.
 */
export function expectedNodeModeBits(posixModeBits) {
  return process.platform === "win32" ? 0o666 : posixModeBits;
}

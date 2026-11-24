// Shared artifact metadata; importing it never loads a writer or lifecycle gate.
export const USAGE_MANIFEST_SCHEMA = "devpro-session-usage-manifest/v1";
export const USAGE_MANIFEST_FILE = "usage-manifest.json";
const USAGE_MANIFEST_ATOMIC_TEMP_FILE_NAME = /^\.usage-manifest\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export function isUsageManifestAtomicTempFileName(fileName) {
  return typeof fileName === "string" && USAGE_MANIFEST_ATOMIC_TEMP_FILE_NAME.test(fileName);
}

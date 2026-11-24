/**
 * primitives.mjs
 *
 * Shared production primitives (hash, blank check, regex escape, slug, object
 * guards). Call sites keep local wrappers only when behavior differs.
 */

import { createHash } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

export function escapeRegExp(t) {
  return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isRepositorySlug(v) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(
    String(v ?? "")
  );
}

/** Loose object check used by projection / sticky / prune call sites. */
export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Prototype-strict object check used by packet / material contracts. */
export function isStrictPlainObject(v) {
  return v !== null
    && typeof v === "object"
    && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
}

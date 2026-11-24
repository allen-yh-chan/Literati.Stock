/** Shared bounded dispatch-id validation for control-evidence path assembly. */
export function isValidDispatchId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function assertDispatchId(value, label = "dispatch_id") {
  if (!isValidDispatchId(value)) {
    const error = new Error(`${label} is not safe for a dispatch evidence directory`);
    error.classification = "reviewer_dispatch_identity_collision";
    throw error;
  }
  return value;
}

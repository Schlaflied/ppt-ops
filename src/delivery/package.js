const ROLES = new Set(["presentation", "learner_guide", "assessment", "alignment_report", "preview", "reference", "source", "internal_evidence"]);
const SECTIONS = new Set(["final", "reference", "source", "internal"]);

export class DeliveryPackageError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

/** Validate a multi-file delivery declaration before any files are copied. */
export function validateDeliveryPackageSpec(spec) {
  if (!spec || spec.schema_version !== "1.0" || !validId(spec.id)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", "package requires schema_version 1.0 and a stable id");
  if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0) throw new DeliveryPackageError("DELIVERY_PACKAGE_EMPTY", "package requires at least one deliverable");
  const ids = new Set();
  for (const [index, item] of spec.deliverables.entries()) {
    if (!validId(item?.id) || ids.has(item.id)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] needs a unique stable id`);
    ids.add(item.id);
    if (!ROLES.has(item.role) || !SECTIONS.has(item.section)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] has an invalid role or section`);
    if (typeof item.file !== "string" || !item.file.trim() || item.file.includes("\0")) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}].file is required`);
    if (typeof item.required !== "boolean") throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}].required must be boolean`);
    if (item.section === "final" && ["reference", "source", "internal_evidence"].includes(item.role)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] cannot place ${item.role} in final`);
  }
  return { ...spec, deliverables: spec.deliverables.map((item) => ({ ...item })) };
}

export function evaluateRequiredDeliverables(spec, availableIds) {
  const valid = validateDeliveryPackageSpec(spec);
  const available = new Set(availableIds ?? []);
  const missing = valid.deliverables.filter((item) => item.required && !available.has(item.id)).map(({ id, role, file }) => ({ id, role, file }));
  return { status: missing.length ? "blocked" : "ready", missing_required: missing };
}

function validId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value); }

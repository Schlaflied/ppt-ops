export const DELIVERY_MODES = Object.freeze(["live_talk", "workshop", "pitch", "leave_behind", "async"]);
export const INTERACTION_KINDS = Object.freeze(["audience_action", "question", "exercise", "demonstration", "feedback"]);

export const DEFAULT_DENSITY_GUIDANCE = Object.freeze({ character_limit: 700, shape_limit: 60 });
export const DELIVERY_MODE_DENSITY_GUIDANCE = Object.freeze({
  live_talk: Object.freeze({ character_limit: 420, shape_limit: 48 }),
  workshop: Object.freeze({ character_limit: 520, shape_limit: 54 }),
  pitch: Object.freeze({ character_limit: 360, shape_limit: 44 }),
  leave_behind: DEFAULT_DENSITY_GUIDANCE,
  async: Object.freeze({ character_limit: 620, shape_limit: 58 })
});

export function densityGuidanceFor(deliveryMode) {
  return DELIVERY_MODE_DENSITY_GUIDANCE[deliveryMode] ?? DEFAULT_DENSITY_GUIDANCE;
}

export function visibleCharacterCount(pageSpec, { boundary = false } = {}) {
  const screen = pageSpec?.screen_text ?? {};
  const values = boundary
    ? [screen.title]
    : [screen.title, screen.subtitle, pageSpec?.three_second_message, ...(screen.body ?? [])];
  return values.filter((value) => typeof value === "string").join(" ").length;
}

export function inspectDeliveryModeFit(project) {
  const deliveryMode = project?.project?.delivery_mode;
  if (!deliveryMode) {
    return {
      status: "pending",
      delivery_mode: null,
      reason: "Project does not declare delivery_mode; legacy density guidance remains in effect.",
      findings: []
    };
  }

  const guidance = densityGuidanceFor(deliveryMode);
  const pages = project.pages ?? [];
  const findings = pages.flatMap((page, index) => {
    const characters = visibleCharacterCount(page, { boundary: index === 0 || index === pages.length - 1 });
    return characters > guidance.character_limit
      ? [{
          page: page.page,
          check: "delivery-mode-density",
          severity: "warning",
          evidence: { delivery_mode: deliveryMode, characters, character_limit: guidance.character_limit }
        }]
      : [];
  });

  if (deliveryMode === "workshop" && !pages.some((page) => page.audience_interaction)) {
    findings.push({
      page: null,
      check: "workshop-interaction",
      severity: "warning",
      evidence: { delivery_mode: deliveryMode, reason: "No PageSpec declares audience_interaction." }
    });
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    delivery_mode: deliveryMode,
    guidance,
    findings,
    summary: findings.length === 0
      ? `PageSpecs fit the automated ${deliveryMode} guidance.`
      : `${findings.length} delivery-mode guidance finding(s) require review.`
  };
}

/** Live marks a presenter can set on a page during a real delivery (#127). */
export const DELIVERY_MARK_KINDS = Object.freeze(["stumble", "question", "skipped"]);
export const DELIVERY_VENUES = Object.freeze(["offline", "online"]);
const DELIVERY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the optional PageSpec `delivery_feedback` history: one entry per imported
 * delivery record, appended by `pptops delivery-retro`. Returns error strings.
 */
export function validateDeliveryFeedback(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ["delivery_feedback must be an array"];
  const errors = [];
  const seen = new Set();
  value.forEach((entry, index) => {
    const field = `delivery_feedback[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.push(`${field} must be an object`); return; }
    const allowed = new Set(["delivery_id", "date", "venue", "actual_seconds", "estimated_seconds", "visit_count", "skipped", "overtime", "marks", "report"]);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) errors.push(`${field}.${key} is not allowed`);
    if (typeof entry.delivery_id !== "string" || !DELIVERY_ID_PATTERN.test(entry.delivery_id)) errors.push(`${field}.delivery_id must be a stable lowercase identifier`);
    else if (seen.has(entry.delivery_id)) errors.push(`${field}.delivery_id is duplicated: ${entry.delivery_id}`);
    else seen.add(entry.delivery_id);
    if (typeof entry.date !== "string" || !DATE_PATTERN.test(entry.date)) errors.push(`${field}.date must be YYYY-MM-DD`);
    if (!DELIVERY_VENUES.includes(entry.venue)) errors.push(`${field}.venue is invalid: ${entry.venue}`);
    if (typeof entry.actual_seconds !== "number" || !Number.isFinite(entry.actual_seconds) || entry.actual_seconds < 0) errors.push(`${field}.actual_seconds must be a non-negative number`);
    if (entry.estimated_seconds !== undefined && (!Number.isInteger(entry.estimated_seconds) || entry.estimated_seconds < 1)) errors.push(`${field}.estimated_seconds must be a positive integer`);
    if (!Number.isInteger(entry.visit_count) || entry.visit_count < 0) errors.push(`${field}.visit_count must be a non-negative integer`);
    for (const flag of ["skipped", "overtime"]) if (typeof entry[flag] !== "boolean") errors.push(`${field}.${flag} must be boolean`);
    if (!Array.isArray(entry.marks) || entry.marks.some((kind) => !DELIVERY_MARK_KINDS.includes(kind)) || new Set(entry.marks).size !== entry.marks.length) errors.push(`${field}.marks must be unique values of ${DELIVERY_MARK_KINDS.join(", ")}`);
    if (entry.report !== undefined && (typeof entry.report !== "string" || entry.report.trim() === "" || entry.report.startsWith("/") || entry.report.split(/[\\/]/).includes(".."))) errors.push(`${field}.report must be a project-relative path`);
  });
  return errors;
}

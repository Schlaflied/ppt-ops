import crypto from "node:crypto";

export function createMixedSourceIndex({ sources, assertions = [], precedence = [], page_bindings = [] }) {
  if (!Array.isArray(sources) || sources.length < 2) throw coded("MIXED_SOURCES_REQUIRED", "mixed index requires at least two registered sources");
  const byId = new Map();
  for (const source of sources) {
    if (!source?.id || !/^[a-f0-9]{64}$/.test(source.sha256 ?? "")) throw coded("SOURCE_IDENTITY_INVALID", "every source requires id and sha256");
    if (byId.has(source.id)) throw coded("SOURCE_DUPLICATE_ID", `duplicate source id: ${source.id}`);
    byId.set(source.id, source);
  }
  const duplicateGroups = [...Map.groupBy(sources, ({ sha256 }) => sha256).entries()].filter(([, group]) => group.length > 1).map(([sha256, group]) => ({ sha256, source_ids: group.map(({ id }) => id).sort() }));
  const normalizedAssertions = assertions.map((item, index) => normalizeAssertion(item, index, byId));
  const conflicts = buildConflicts(normalizedAssertions, precedence, byId);
  const bindings = page_bindings.map((binding, index) => normalizeBinding(binding, index, byId, normalizedAssertions));
  const payload = { contract_version: "1.0", kind: "mixed_source_index", sources: sources.map(({ id, sha256, media_kind, mime }) => ({ id, sha256, media_kind: media_kind ?? null, mime: mime ?? null })).sort((a, b) => a.id.localeCompare(b.id)), duplicate_groups: duplicateGroups, assertions: normalizedAssertions, conflicts, page_bindings: bindings, review: { state: conflicts.some(({ decision }) => decision === "pending") ? "needs_review" : "pending_review", pending_conflicts: conflicts.filter(({ decision }) => decision === "pending").map(({ key }) => key) } };
  return { ...payload, id: `mixed-index-${hash(payload).slice(0, 16)}` };
}

function normalizeAssertion(item, index, sources) {
  if (!sources.has(item?.source_id)) throw coded("ASSERTION_SOURCE_UNKNOWN", `assertions[${index}] references unknown source`);
  const key = String(item.key ?? "").trim().toLowerCase(), value = String(item.value ?? "").trim(), locator = item.locator;
  if (!key || !value || !locator || typeof locator !== "object") throw coded("ASSERTION_INVALID", `assertions[${index}] requires key, value, and locator`);
  const evidenceKind = String(item.evidence_kind ?? "");
  if (!["structured_extraction", "visual_observation", "transcription", "model_inference", "user_confirmation"].includes(evidenceKind)) throw coded("ASSERTION_EVIDENCE_INVALID", `assertions[${index}].evidence_kind is invalid`);
  return { id: `assertion-${index + 1}`, key, value, source_id: item.source_id, locator: structuredClone(locator), evidence_kind: evidenceKind, confirmation: evidenceKind === "user_confirmation" ? "confirmed" : "unconfirmed" };
}
function buildConflicts(assertions, decisions, sources) {
  const byKey = Map.groupBy(assertions, ({ key }) => key), decisionByKey = new Map(decisions.map((item) => [String(item.key ?? "").trim().toLowerCase(), item]));
  return [...byKey.entries()].filter(([, items]) => new Set(items.map(({ value }) => value)).size > 1).map(([key, items]) => {
    const decision = decisionByKey.get(key);
    if (decision && !sources.has(decision.source_id)) throw coded("PRECEDENCE_SOURCE_UNKNOWN", `precedence for ${key} references unknown source`);
    return { key, assertion_ids: items.map(({ id }) => id), values: [...new Set(items.map(({ value }) => value))].sort(), decision: decision ? "user_selected" : "pending", ...(decision ? { authoritative_source_id: decision.source_id, actor: "user", reason: String(decision.reason ?? "").trim() } : {}) };
  });
}
function normalizeBinding(binding, index, sources, assertions) {
  if (!/^page-\d{3}$/.test(binding?.page_id ?? "")) throw coded("PAGE_BINDING_INVALID", `page_bindings[${index}].page_id is invalid`);
  if (!sources.has(binding?.source_id)) throw coded("PAGE_BINDING_SOURCE_UNKNOWN", `page_bindings[${index}] references unknown source`);
  if (!assertions.some(({ id, source_id }) => id === binding.assertion_id && source_id === binding.source_id)) throw coded("PAGE_BINDING_ASSERTION_UNKNOWN", `page_bindings[${index}] references unknown assertion`);
  return { page_id: binding.page_id, source_id: binding.source_id, assertion_id: binding.assertion_id, locator: structuredClone(binding.locator ?? {}) };
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function coded(code, message) { return Object.assign(new Error(message), { code }); }

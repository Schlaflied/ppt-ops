import crypto from "node:crypto";

const REQUIRED_CASES = ["image", "audio", "video", "mixed"];

export function createMultimodalAcceptanceReport({ cases, privacy, recovery, actor }) {
  if (!Array.isArray(cases)) throw coded("ACCEPTANCE_CASES_REQUIRED", "cases must be an array");
  if (typeof actor !== "string" || !actor.trim()) throw coded("ACCEPTANCE_ACTOR_REQUIRED", "an explicit acceptance actor is required");
  const byKind = new Map(cases.map((item) => [item.kind, normalizeCase(item)]));
  const missing = REQUIRED_CASES.filter((kind) => !byKind.has(kind));
  const privacyEvidence = normalizePrivacy(privacy);
  const recoveryEvidence = normalizeRecovery(recovery);
  const gates = {
    case_coverage: missing.length === 0 && REQUIRED_CASES.every((kind) => byKind.get(kind).automated_status === "passed"),
    privacy: privacyEvidence.unauthorized_external_transfers === 0 && privacyEvidence.authorization_gate_tested,
    cancellation_and_recovery: recoveryEvidence.cancelled_without_partial_success && recoveryEvidence.retry_idempotent && recoveryEvidence.interruption_evidence_hash !== null,
    real_authorized_case: REQUIRED_CASES.every((kind) => byKind.get(kind)?.evidence_type === "real_authorized" && byKind.get(kind)?.human_status === "accepted")
  };
  const payload = { contract_version: "1.0", kind: "multimodal_acceptance_report", actor: actor.trim(), cases: REQUIRED_CASES.map((kind) => byKind.get(kind)).filter(Boolean), privacy: privacyEvidence, recovery: recoveryEvidence, gates, missing_cases: missing, completion: Object.values(gates).every(Boolean) ? "complete" : "pending" };
  return { ...payload, id: `multimodal-acceptance-${hash(payload).slice(0, 16)}` };
}

function normalizeCase(item) {
  if (!REQUIRED_CASES.includes(item?.kind)) throw coded("ACCEPTANCE_CASE_INVALID", `unknown case kind: ${item?.kind}`);
  if (!/^[a-f0-9]{64}$/.test(item.evidence_sha256 ?? "")) throw coded("ACCEPTANCE_EVIDENCE_INVALID", `${item.kind} case requires evidence_sha256`);
  if (!["synthetic", "real_authorized"].includes(item.evidence_type)) throw coded("ACCEPTANCE_EVIDENCE_TYPE_INVALID", `${item.kind} evidence_type is invalid`);
  if (!['passed','failed'].includes(item.automated_status) || !['pending','accepted','rejected'].includes(item.human_status)) throw coded("ACCEPTANCE_STATUS_INVALID", `${item.kind} case status is invalid`);
  return { kind: item.kind, evidence_sha256: item.evidence_sha256, evidence_type: item.evidence_type, automated_status: item.automated_status, human_status: item.human_status, real_powerpoint_status: item.real_powerpoint_status ?? "not_applicable" };
}
function normalizePrivacy(value) { return { external_processing_enabled: value?.external_processing_enabled === true, authorization_gate_tested: value?.authorization_gate_tested === true, unauthorized_external_transfers: Number.isInteger(value?.unauthorized_external_transfers) ? value.unauthorized_external_transfers : -1, ...(value?.authorization_evidence_sha256 ? { authorization_evidence_sha256: value.authorization_evidence_sha256 } : {}) }; }
function normalizeRecovery(value) { return { cancelled_without_partial_success: value?.cancelled_without_partial_success === true, retry_idempotent: value?.retry_idempotent === true, interruption_evidence_hash: /^[a-f0-9]{64}$/.test(value?.interruption_evidence_hash ?? "") ? value.interruption_evidence_hash : null }; }
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function coded(code, message) { return Object.assign(new Error(message), { code }); }

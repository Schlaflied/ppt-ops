import assert from "node:assert/strict";
import test from "node:test";
import { createMultimodalAcceptanceReport } from "../src/sources/multimodal-acceptance.js";

const digest = "d".repeat(64);
const syntheticCases = ["image", "audio", "video", "mixed"].map((kind) => ({ kind, evidence_sha256: digest, evidence_type: "synthetic", automated_status: "passed", human_status: "pending" }));
const privacy = { external_processing_enabled: false, authorization_gate_tested: true, unauthorized_external_transfers: 0 };
const recovery = { cancelled_without_partial_success: true, retry_idempotent: true, interruption_evidence_hash: digest };

test("Stage 6 keeps synthetic regression evidence separate from real authorized acceptance", () => {
  const report = createMultimodalAcceptanceReport({ cases: syntheticCases, privacy, recovery, actor: "qa-agent" });
  assert.equal(report.gates.case_coverage, true);
  assert.equal(report.gates.privacy, true);
  assert.equal(report.gates.cancellation_and_recovery, true);
  assert.equal(report.gates.real_authorized_case, false);
  assert.equal(report.completion, "pending");
  assert.equal(report.id, createMultimodalAcceptanceReport({ cases: syntheticCases, privacy, recovery, actor: "qa-agent" }).id);
});

test("Stage 6 completes only with four real authorized and human-accepted cases", () => {
  const realCases = syntheticCases.map((item) => ({ ...item, evidence_type: "real_authorized", human_status: "accepted" }));
  const report = createMultimodalAcceptanceReport({ cases: realCases, privacy, recovery, actor: "Yuting Sun" });
  assert.equal(report.completion, "complete");
  assert.ok(Object.values(report.gates).every(Boolean));
});

test("Stage 6 fails closed for missing cases, privacy breaches, and absent recovery evidence", () => {
  const report = createMultimodalAcceptanceReport({ cases: syntheticCases.slice(0, 2), privacy: { ...privacy, unauthorized_external_transfers: 1 }, recovery: {}, actor: "qa-agent" });
  assert.deepEqual(report.missing_cases, ["video", "mixed"]);
  assert.equal(report.gates.case_coverage, false);
  assert.equal(report.gates.privacy, false);
  assert.equal(report.gates.cancellation_and_recovery, false);
  assert.throws(() => createMultimodalAcceptanceReport({ cases: [{ ...syntheticCases[0], evidence_sha256: "bad" }], privacy, recovery, actor: "qa-agent" }), (error) => error.code === "ACCEPTANCE_EVIDENCE_INVALID");
});

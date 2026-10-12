import assert from "node:assert/strict";
import test from "node:test";
import { evaluateImageSemanticAcceptance } from "../src/acceptance/image-semantics.js";

test("synthetic evidence cannot satisfy real PowerPoint acceptance", () => {
  const result = evaluateImageSemanticAcceptance({ authorized_real_case: false, pptx_reopened_in_powerpoint: false, compositions: [], evidence: {}, checks: {} });
  assert.equal(result.status, "pending");
  assert.equal(result.synthetic_fixture_is_acceptance, false);
  assert.ok(result.findings.some((item) => item.includes("authorized real case")));
});

test("acceptance requires all compositions, evidence layers and editability checks", () => {
  const result = evaluateImageSemanticAcceptance({
    authorized_real_case: true,
    pptx_reopened_in_powerpoint: true,
    compositions: ["four-panel", "multiple-people", "multi-step", "single-subject-whitespace"],
    evidence: { automated_qa: "qa.json", agent_observation: "agent.md", human_visual_acceptance: "human.md", powerpoint_acceptance: "powerpoint.md" },
    checks: { editable_text: true, editable_labels: true, editable_connectors: true, crop_preserved: true, scale_legible: true }
  });
  assert.deepEqual(result, { status: "accepted", synthetic_fixture_is_acceptance: false, findings: [] });
});

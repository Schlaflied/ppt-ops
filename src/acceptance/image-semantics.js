const REQUIRED_COMPOSITIONS = ["four-panel", "multiple-people", "multi-step", "single-subject-whitespace"];
const REQUIRED_LAYERS = ["automated_qa", "agent_observation", "human_visual_acceptance", "powerpoint_acceptance"];

/** Evaluate evidence completeness without treating generated fixtures as real acceptance. */
export function evaluateImageSemanticAcceptance(record) {
  const findings = [];
  if (!record?.authorized_real_case) findings.push("authorized real case is required");
  if (!record?.pptx_reopened_in_powerpoint) findings.push("PPTX must be reopened in real PowerPoint");
  for (const composition of REQUIRED_COMPOSITIONS) if (!record?.compositions?.includes(composition)) findings.push(`missing composition: ${composition}`);
  for (const layer of REQUIRED_LAYERS) if (!record?.evidence?.[layer]) findings.push(`missing evidence layer: ${layer}`);
  for (const check of ["editable_text", "editable_labels", "editable_connectors", "crop_preserved", "scale_legible"]) if (record?.checks?.[check] !== true) findings.push(`acceptance check not passed: ${check}`);
  return { status: findings.length ? "pending" : "accepted", synthetic_fixture_is_acceptance: false, findings };
}

export const imageSemanticAcceptanceRequirements = Object.freeze({ compositions: REQUIRED_COMPOSITIONS, evidence_layers: REQUIRED_LAYERS });

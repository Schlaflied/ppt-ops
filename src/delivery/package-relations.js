const RELATION_TYPES = new Set(["references", "derived_from", "aligns_with", "supersedes"]);

/** Validate cross-file relationships and reported page/link/reference expectations. */
export function inspectPackageRelations(manifest, relations = [], checks = []) {
  const files = new Map((manifest.files ?? []).map((file) => [file.id, file]));
  const findings = [];
  const normalizedRelations = [];
  for (const [index, relation] of relations.entries()) {
    if (!RELATION_TYPES.has(relation?.type) || !files.has(relation?.from) || !files.has(relation?.to)) {
      findings.push(finding("package-relation-invalid", "error", { index, relation })); continue;
    }
    normalizedRelations.push({ type: relation.type, from: relation.from, to: relation.to, ...(relation.locator ? { locator: relation.locator } : {}) });
  }
  for (const check of checks) {
    if (!files.has(check.artifact_id)) { findings.push(finding("package-check-artifact-missing", "error", check)); continue; }
    if (check.kind === "page_count" && check.actual !== check.expected) findings.push(finding("package-page-count-mismatch", "error", check));
    else if (check.kind === "reference" && check.resolved !== true) findings.push(finding("package-reference-unresolved", "error", check));
    else if (check.kind === "link" && check.resolved !== true) findings.push(finding("package-link-unresolved", "error", check));
    else if (!["page_count", "reference", "link"].includes(check.kind)) findings.push(finding("package-check-unsupported", "warning", check));
  }
  return { status: findings.some(({ severity }) => severity === "error") ? "blocked" : findings.length ? "review" : "passed", relations: normalizedRelations, findings, automated_result_is_human_acceptance: false };
}

function finding(check, severity, evidence) { return { check, severity, evidence }; }

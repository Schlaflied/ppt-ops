import assert from "node:assert/strict";
import test from "node:test";
import { inspectPackageRelations } from "../src/delivery/package-relations.js";

const manifest = { files: [{ id: "deck" }, { id: "guide" }, { id: "assessment" }, { id: "alignment" }] };

test("cross-file relations retain artifact identities and locators", () => {
  const result = inspectPackageRelations(manifest, [
    { type: "aligns_with", from: "assessment", to: "alignment", locator: "LO-1" },
    { type: "references", from: "guide", to: "deck", locator: "slide:4" }
  ], [{ kind: "page_count", artifact_id: "guide", expected: 8, actual: 8 }, { kind: "link", artifact_id: "guide", target: "deck", resolved: true }]);
  assert.equal(result.status, "passed");
  assert.equal(result.relations[0].locator, "LO-1");
  assert.equal(result.automated_result_is_human_acceptance, false);
});

test("missing artifacts, page mismatches, and unresolved links block a package", () => {
  const result = inspectPackageRelations(manifest, [{ type: "references", from: "missing", to: "deck" }], [
    { kind: "page_count", artifact_id: "guide", expected: 8, actual: 7 },
    { kind: "reference", artifact_id: "alignment", locator: "LO-2", resolved: false }
  ]);
  assert.equal(result.status, "blocked");
  for (const check of ["package-relation-invalid", "package-page-count-mismatch", "package-reference-unresolved"]) assert.ok(result.findings.some((item) => item.check === check));
});

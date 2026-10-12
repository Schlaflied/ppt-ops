import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticCandidate, reviewSemanticCandidate } from "../src/visual-assets/semantic-review.js";

test("machine candidates remain pending until an explicit human decision", () => {
  const candidate = createSemanticCandidate({ asset_id: "scene", analyzer: "local", analyzer_version: "1", observed_at: "2026-10-11T00:00:00Z", regions: [{ role: "person", bounds: { x: 0, y: 0, width: 0.5, height: 1 }, confidence: 1.4 }] });
  assert.equal(candidate.annotation_state, "machine_observed");
  assert.equal(candidate.review.status, "pending");
  assert.equal(candidate.semantic_regions[0].confidence, 1);
});

test("accept, edit and reject decisions are auditable and preserve observation metadata", () => {
  const candidate = createSemanticCandidate({ asset_id: "scene", analyzer: "local", analyzer_version: "1", observed_at: "2026-10-11T00:00:00Z", regions: [{ id: "left", role: "person", bounds: { x: 0, y: 0, width: 0.5, height: 1 }, confidence: 0.7 }] });
  const accepted = reviewSemanticCandidate(candidate, { decision: "accepted", reviewer: "user", decided_at: "2026-10-11T00:01:00Z" });
  assert.equal(accepted.annotation_state, "user_confirmed");
  assert.equal("confidence" in accepted.semantic_regions[0], false);
  assert.equal(accepted.analyzer.name, "local");
  const rejected = reviewSemanticCandidate(candidate, { decision: "rejected", reviewer: "user", decided_at: "2026-10-11T00:02:00Z", reason: "wrong subject" });
  assert.equal(rejected.annotation_state, "machine_observed");
  assert.equal(rejected.review.status, "rejected");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createMixedSourceIndex } from "../src/sources/mixed-index.js";

const sources = [
  { id: "source-image", sha256: "a".repeat(64), media_kind: "image", mime: "image/png" },
  { id: "source-audio", sha256: "b".repeat(64), media_kind: "audio", mime: "audio/wav" }
];
const assertions = [
  { source_id: "source-image", key: "required-action", value: "Stop work", locator: { page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }, evidence_kind: "structured_extraction" },
  { source_id: "source-audio", key: "required-action", value: "Report first", locator: { start_ms: 0, end_ms: 1000 }, evidence_kind: "transcription" }
];

test("Stage 5 exposes mixed-source conflicts and page-addressable bindings", () => {
  const pending = createMixedSourceIndex({ sources, assertions, page_bindings: [{ page_id: "page-001", source_id: "source-image", assertion_id: "assertion-1", locator: assertions[0].locator }] });
  assert.equal(pending.review.state, "needs_review");
  assert.equal(pending.conflicts[0].decision, "pending");
  const decided = createMixedSourceIndex({ sources, assertions, precedence: [{ key: "required-action", source_id: "source-image", reason: "User selected the approved poster" }], page_bindings: pending.page_bindings });
  assert.equal(decided.conflicts[0].decision, "user_selected");
  assert.equal(decided.conflicts[0].authoritative_source_id, "source-image");
  assert.equal(decided.id, createMixedSourceIndex({ sources, assertions, precedence: [{ key: "required-action", source_id: "source-image", reason: "User selected the approved poster" }], page_bindings: pending.page_bindings }).id);
});

test("Stage 5 detects duplicate bytes and rejects invented sources or page bindings", () => {
  const duplicate = createMixedSourceIndex({ sources: [...sources, { ...sources[0], id: "source-copy" }] });
  assert.deepEqual(duplicate.duplicate_groups[0].source_ids, ["source-copy", "source-image"]);
  assert.throws(() => createMixedSourceIndex({ sources, assertions: [{ ...assertions[0], source_id: "missing" }] }), (error) => error.code === "ASSERTION_SOURCE_UNKNOWN");
  assert.throws(() => createMixedSourceIndex({ sources, assertions, page_bindings: [{ page_id: "page-1", source_id: "source-image", assertion_id: "assertion-1" }] }), (error) => error.code === "PAGE_BINDING_INVALID");
  assert.throws(() => createMixedSourceIndex({ sources, assertions, page_bindings: [{ page_id: "page-001", source_id: "source-audio", assertion_id: "assertion-1" }] }), (error) => error.code === "PAGE_BINDING_ASSERTION_UNKNOWN");
});

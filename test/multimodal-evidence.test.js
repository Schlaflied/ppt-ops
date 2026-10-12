import assert from "node:assert/strict";
import test from "node:test";
import { createImageOcrEvidence } from "../src/sources/multimodal-evidence.js";

const image = { id: "source-image", sha256: "a".repeat(64), media_kind: "image" };

test("Stage 2 records deterministic local OCR evidence with page and region locators", () => {
  const input = { source: image, engine: { name: "fixture-ocr", version: "1", execution: "local" }, regions: [
    { locator: { page: 1, region: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 } }, text: "Emergency exit", confidence: 0.96 },
    { locator: { page: 1, region: { x: 0.6, y: 0.2, width: 0.3, height: 0.2 } }, text: "", confidence: 0.2, unreadable: true }
  ] };
  const first = createImageOcrEvidence(input), second = createImageOcrEvidence(input);
  assert.deepEqual(second, first);
  assert.equal(first.processing, "local_only");
  assert.equal(first.external_authorized, false);
  assert.deepEqual(first.regions.map(({ state }) => state), ["pending_review", "unreadable"]);
  assert.equal(first.review.state, "needs_review");
});

test("Stage 2 rejects cloud engines, wrong sources, invalid regions, and confidence", () => {
  const valid = { source: image, engine: { name: "ocr", version: "1", execution: "local" }, regions: [{ locator: { page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }, text: "x", confidence: 1 }] };
  assert.throws(() => createImageOcrEvidence({ ...valid, engine: { ...valid.engine, execution: "cloud" } }), (error) => error.code === "LOCAL_ENGINE_REQUIRED");
  assert.throws(() => createImageOcrEvidence({ ...valid, source: { ...image, media_kind: "audio" } }), (error) => error.code === "SOURCE_MEDIA_MISMATCH");
  assert.throws(() => createImageOcrEvidence({ ...valid, regions: [{ ...valid.regions[0], confidence: 2 }] }), (error) => error.code === "OCR_CONFIDENCE_INVALID");
  assert.throws(() => createImageOcrEvidence({ ...valid, regions: [{ ...valid.regions[0], locator: { page: 1, region: { x: .8, y: 0, width: .4, height: 1 } } }] }), (error) => error.code === "OCR_LOCATOR_INVALID");
});

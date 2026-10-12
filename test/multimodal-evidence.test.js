import assert from "node:assert/strict";
import test from "node:test";
import { createAudioTranscriptEvidence, createImageOcrEvidence } from "../src/sources/multimodal-evidence.js";

const image = { id: "source-image", sha256: "a".repeat(64), media_kind: "image" };
const audio = { id: "source-audio", sha256: "b".repeat(64), media_kind: "audio" };

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

test("Stage 3 records ordered local transcripts with speakers, overlap, and review states", () => {
  const input = { source: audio, engine: { name: "fixture-asr", version: "1", execution: "local" }, segments: [
    { start_ms: 0, end_ms: 1200, text: "Report the hazard", speaker: "speaker-1", confidence: 0.94 },
    { start_ms: 1200, end_ms: 1800, text: "", speaker: "unknown", confidence: 0.3, inaudible: true, overlap: true }
  ] };
  const result = createAudioTranscriptEvidence(input);
  assert.equal(result.id, createAudioTranscriptEvidence(input).id);
  assert.deepEqual(result.segments.map(({ state }) => state), ["pending_review", "inaudible"]);
  assert.equal(result.segments[1].overlap, true);
  assert.equal(result.review.state, "needs_review");
});

test("Stage 3 rejects cloud engines, wrong media, overlapping ranges, and invalid confidence", () => {
  const valid = { source: audio, engine: { name: "asr", version: "1", execution: "local" }, segments: [{ start_ms: 0, end_ms: 1000, text: "x", speaker: "speaker-1", confidence: 1 }] };
  assert.throws(() => createAudioTranscriptEvidence({ ...valid, engine: { ...valid.engine, execution: "cloud" } }), (error) => error.code === "LOCAL_ENGINE_REQUIRED");
  assert.throws(() => createAudioTranscriptEvidence({ ...valid, source: image }), (error) => error.code === "SOURCE_MEDIA_MISMATCH");
  assert.throws(() => createAudioTranscriptEvidence({ ...valid, segments: [...valid.segments, { ...valid.segments[0], start_ms: 500, end_ms: 1500 }] }), (error) => error.code === "TRANSCRIPT_TIME_RANGE_INVALID");
  assert.throws(() => createAudioTranscriptEvidence({ ...valid, segments: [{ ...valid.segments[0], confidence: -1 }] }), (error) => error.code === "TRANSCRIPT_CONFIDENCE_INVALID");
});

test("Stage 2 rejects cloud engines, wrong sources, invalid regions, and confidence", () => {
  const valid = { source: image, engine: { name: "ocr", version: "1", execution: "local" }, regions: [{ locator: { page: 1, region: { x: 0, y: 0, width: 1, height: 1 } }, text: "x", confidence: 1 }] };
  assert.throws(() => createImageOcrEvidence({ ...valid, engine: { ...valid.engine, execution: "cloud" } }), (error) => error.code === "LOCAL_ENGINE_REQUIRED");
  assert.throws(() => createImageOcrEvidence({ ...valid, source: { ...image, media_kind: "audio" } }), (error) => error.code === "SOURCE_MEDIA_MISMATCH");
  assert.throws(() => createImageOcrEvidence({ ...valid, regions: [{ ...valid.regions[0], confidence: 2 }] }), (error) => error.code === "OCR_CONFIDENCE_INVALID");
  assert.throws(() => createImageOcrEvidence({ ...valid, regions: [{ ...valid.regions[0], locator: { page: 1, region: { x: .8, y: 0, width: .4, height: 1 } } }] }), (error) => error.code === "OCR_LOCATOR_INVALID");
});

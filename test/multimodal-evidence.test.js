import assert from "node:assert/strict";
import test from "node:test";
import { createAudioTranscriptEvidence, createImageOcrEvidence, createVideoEvidence } from "../src/sources/multimodal-evidence.js";

const image = { id: "source-image", sha256: "a".repeat(64), media_kind: "image" };
const audio = { id: "source-audio", sha256: "b".repeat(64), media_kind: "audio" };
const video = { id: "source-video", sha256: "c".repeat(64), media_kind: "video" };

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

test("Stage 4 combines speech, frame text, and visual events with traceable video locators", () => {
  const input = { source: video, engine: { name: "fixture-video", version: "1", execution: "local" }, duration_ms: 5000,
    speech: [{ start_ms: 0, end_ms: 1500, keyframe_ms: 500, text: "Open the panel", speaker: "speaker-1", confidence: .95 }],
    frame_text: [{ start_ms: 1000, end_ms: 2500, keyframe_ms: 1500, text: "Hazard report", confidence: .9, region: { x: .1, y: .1, width: .4, height: .2 } }],
    visual_events: [{ start_ms: 2500, end_ms: 4000, keyframe_ms: 3000, text: "User submits form", confidence: .7, unresolved: true }]
  };
  const result = createVideoEvidence(input);
  assert.equal(result.id, createVideoEvidence(input).id);
  assert.deepEqual(Object.keys(result.channels), ["speech", "frame_text", "visual_events"]);
  assert.equal(result.channels.frame_text[0].region.width, .4);
  assert.equal(result.review.state, "needs_review");
});

test("Stage 4 supports silent video and rejects invalid duration, locators, and empty evidence", () => {
  const base = { source: video, engine: { name: "video", version: "1", execution: "local" }, duration_ms: 2000, visual_events: [{ start_ms: 0, end_ms: 1000, keyframe_ms: 500, text: "Cursor moves", confidence: 1 }] };
  assert.equal(createVideoEvidence(base).channels.speech.length, 0);
  assert.throws(() => createVideoEvidence({ ...base, speech: [], frame_text: [], visual_events: [] }), (error) => error.code === "VIDEO_EVIDENCE_REQUIRED");
  assert.throws(() => createVideoEvidence({ ...base, duration_ms: 0 }), (error) => error.code === "VIDEO_DURATION_INVALID");
  assert.throws(() => createVideoEvidence({ ...base, visual_events: [{ ...base.visual_events[0], keyframe_ms: 2500 }] }), (error) => error.code === "VIDEO_LOCATOR_INVALID");
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

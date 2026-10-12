import crypto from "node:crypto";

export function createImageOcrEvidence({ source, engine, regions }) {
  requireMedia(source, "image");
  requireLocalEngine(engine);
  if (!Array.isArray(regions) || regions.length === 0) throw coded("OCR_REGIONS_REQUIRED", "OCR evidence requires at least one region");
  const normalized = regions.map((region, index) => normalizeImageRegion(region, index));
  const payload = {
    contract_version: "1.0", kind: "image_ocr_evidence", source_id: source.id, source_sha256: source.sha256,
    engine: cleanEngine(engine), processing: "local_only", external_authorized: false,
    regions: normalized,
    review: reviewSummary(normalized)
  };
  return { ...payload, id: `image-ocr-${digest(payload).slice(0, 16)}` };
}

export function createAudioTranscriptEvidence({ source, engine, segments }) {
  requireMedia(source, "audio");
  requireLocalEngine(engine);
  if (!Array.isArray(segments) || segments.length === 0) throw coded("TRANSCRIPT_SEGMENTS_REQUIRED", "transcription requires at least one segment");
  let previousEnd = 0;
  const normalized = segments.map((segment, index) => {
    const start = Number(segment.start_ms), end = Number(segment.end_ms), confidence = Number(segment.confidence);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || start < previousEnd) throw coded("TRANSCRIPT_TIME_RANGE_INVALID", `segments[${index}] requires ordered non-overlapping millisecond ranges`);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw coded("TRANSCRIPT_CONFIDENCE_INVALID", `segments[${index}].confidence must be between 0 and 1`);
    previousEnd = end;
    const text = String(segment.text ?? "");
    const speaker = String(segment.speaker ?? "unknown").trim() || "unknown";
    const state = segment.inaudible === true ? "inaudible" : confidence < 0.8 || speaker === "unknown" ? "low_confidence" : "pending_review";
    return { id: `transcript-${index + 1}`, locator: { start_ms: start, end_ms: end }, text, speaker, confidence, evidence_kind: "transcription", state, ...(segment.overlap === true ? { overlap: true } : {}) };
  });
  const payload = { contract_version: "1.0", kind: "audio_transcript_evidence", source_id: source.id, source_sha256: source.sha256, engine: cleanEngine(engine), processing: "local_only", external_authorized: false, segments: normalized, review: reviewSummary(normalized) };
  return { ...payload, id: `audio-transcript-${digest(payload).slice(0, 16)}` };
}

function normalizeImageRegion(region, index) {
  const locator = region?.locator;
  if (!Number.isInteger(locator?.page) || locator.page < 1) throw coded("OCR_LOCATOR_INVALID", `regions[${index}].locator.page must be positive`);
  validateBounds(locator.region, `regions[${index}].locator.region`);
  const text = String(region.text ?? "");
  const confidence = Number(region.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw coded("OCR_CONFIDENCE_INVALID", `regions[${index}].confidence must be between 0 and 1`);
  const state = region.unreadable === true ? "unreadable" : confidence < 0.8 ? "low_confidence" : "pending_review";
  return { id: `ocr-region-${index + 1}`, locator: { page: locator.page, region: orderedBounds(locator.region) }, text, confidence, evidence_kind: "structured_extraction", state };
}

function requireMedia(source, expected) { if (source?.media_kind !== expected || !source?.id || !/^[a-f0-9]{64}$/.test(source?.sha256 ?? "")) throw coded("SOURCE_MEDIA_MISMATCH", `a registered ${expected} source is required`); }
function requireLocalEngine(engine) { if (!engine || engine.execution !== "local" || !String(engine.name ?? "").trim() || !String(engine.version ?? "").trim()) throw coded("LOCAL_ENGINE_REQUIRED", "engine name/version and execution=local are required"); }
function cleanEngine(engine) { return { name: String(engine.name).trim(), version: String(engine.version).trim(), execution: "local" }; }
function validateBounds(value, field) { if (!value || ["x", "y", "width", "height"].some((key) => !Number.isFinite(value[key])) || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x + value.width > 1 || value.y + value.height > 1) throw coded("OCR_LOCATOR_INVALID", `${field} must be normalized bounds`); }
function orderedBounds(value) { return { x: value.x, y: value.y, width: value.width, height: value.height }; }
function reviewSummary(items) { const states = [...new Set(items.map(({ state }) => state))].sort(); return { state: states.some((state) => state !== "pending_review") ? "needs_review" : "pending_review", reasons: states }; }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function coded(code, message) { return Object.assign(new Error(message), { code }); }

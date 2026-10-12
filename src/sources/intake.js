import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { createV1Entity } from "../contracts/v1.js";
import { resolveProjectPath } from "../core/project.js";

const DEFAULT_LIMITS = Object.freeze({ maxFileBytes: 50 * 1024 * 1024, maxEntries: 5000, maxExpandedBytes: 200 * 1024 * 1024, maxEntryBytes: 25 * 1024 * 1024 });
const TYPES = Object.freeze({
  ".md": { mime: "text/markdown", parser: "markdown" },
  ".markdown": { mime: "text/markdown", parser: "markdown" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parser: "docx" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", parser: "pptx" },
  ".png": { mime: "image/png", parser: "multimodal-manifest", media: "image", signature: "png" },
  ".jpg": { mime: "image/jpeg", parser: "multimodal-manifest", media: "image", signature: "jpeg" },
  ".jpeg": { mime: "image/jpeg", parser: "multimodal-manifest", media: "image", signature: "jpeg" },
  ".wav": { mime: "audio/wav", parser: "multimodal-manifest", media: "audio", signature: "wav" },
  ".mp3": { mime: "audio/mpeg", parser: "multimodal-manifest", media: "audio", signature: "mp3" },
  ".mp4": { mime: "video/mp4", parser: "multimodal-manifest", media: "video", signature: "mp4" },
  ".webm": { mime: "video/webm", parser: "multimodal-manifest", media: "video", signature: "webm" }
});

const MULTIMODAL_CAPABILITIES = Object.freeze({
  contract_version: "1.0", stage: "stage_1_contract_only", local_first: true, external_processing: "explicit_authorization_required",
  evidence_kinds: ["structured_extraction", "visual_observation", "transcription", "model_inference", "user_confirmation"],
  review_states: ["pending_review", "unreadable", "inaudible", "low_confidence", "conflict"],
  media: {
    image: { formats: ["png", "jpeg"], locators: ["page", "region"], implemented: ["immutable_registration"], pending: ["ocr", "visual_observation"] },
    audio: { formats: ["wav", "mp3"], locators: ["time_range"], implemented: ["immutable_registration"], pending: ["transcription", "speaker_diarization"] },
    video: { formats: ["mp4", "webm"], locators: ["time_range", "keyframe", "region"], implemented: ["immutable_registration"], pending: ["audio_transcription", "frame_text", "visual_events"] }
  }
});

export function multimodalCapabilities() { return structuredClone(MULTIMODAL_CAPABILITIES); }

export class SourceIntake {
  constructor({ projectRoot, store, projectId, limits = {} }) {
    this.root = path.resolve(projectRoot);
    this.store = store;
    this.projectId = projectId;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async importFile(inputFile, { signal } = {}) {
    throwIfAborted(signal);
    const input = path.resolve(inputFile);
    const contents = await fs.readFile(input);
    throwIfAborted(signal);
    if (contents.byteLength > this.limits.maxFileBytes) throw intakeError("SOURCE_TOO_LARGE", `source exceeds ${this.limits.maxFileBytes} bytes`);
    const definition = TYPES[path.extname(input).toLowerCase()];
    if (!definition) throw intakeError("UNSUPPORTED_SOURCE_TYPE", "supported sources: Markdown, DOCX, PPTX, PNG, JPEG, WAV, MP3, MP4, and WebM");
    verifySignature(contents, definition.signature ?? definition.parser);
    const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
    const existing = this.store?.listEntities(this.projectId, "source").find((source) => source.sha256 === sha256);
    if (existing) return { source: existing, duplicate: true, extracted: await this.readExtraction(existing) };

    const extracted = definition.parser === "markdown" ? extractMarkdown(contents.toString("utf8"))
      : definition.parser === "multimodal-manifest" ? createMultimodalManifest({ sha256, definition })
      : await extractOpenXml(contents, definition.parser, this.limits);
    const id = `source-${sha256.slice(0, 12)}`;
    const extension = path.extname(input).toLowerCase();
    const managedFile = path.join(".pptops", "sources", sha256, `original${extension}`);
    const extractionFile = path.join(".pptops", "sources", sha256, "extracted.json");
    await writeImmutable(this.root, managedFile, contents);
    throwIfAborted(signal);
    await writeImmutable(this.root, extractionFile, `${JSON.stringify(extracted, null, 2)}\n`);
    const source = createV1Entity("source", id, {
      file: managedFile, original_name: path.basename(input), bytes: contents.byteLength, mime: definition.mime, sha256,
      parser: { name: definition.parser, version: "1" }, extraction_file: extractionFile,
      ...(definition.media ? { media_kind: definition.media, capability_stage: "stage_1_contract_only", review_state: "pending_review" } : {}),
      segment_count: extracted.segments.length
    });
    return { source: this.store ? this.store.saveEntity(this.projectId, source) : source, duplicate: false, extracted };
  }

  async readExtraction(source) {
    return JSON.parse(await fs.readFile(resolveProjectPath(this.root, source.extraction_file), "utf8"));
  }

  async correctExtraction(sourceId, segments) {
    if (!this.store) throw new Error("corrections require a persistence store");
    const source = this.store.getEntity(this.projectId, "source", sourceId);
    if (!source) throw intakeError("SOURCE_NOT_FOUND", `unknown source: ${sourceId}`);
    validateSegments(segments);
    const revision = (source.correction_revision ?? 0) + 1;
    const extracted = { format: source.parser.name, text: segments.map(({ text }) => text).join("\n"), segments, corrected: true, correction_revision: revision };
    const extractionFile = path.join(".pptops", "sources", source.sha256, `extracted.r${revision}.json`);
    await writeImmutable(this.root, extractionFile, `${JSON.stringify(extracted, null, 2)}\n`);
    const { revision: _storedRevision, ...contract } = source;
    const updated = this.store.saveEntity(this.projectId, { ...contract, extraction_file: extractionFile, segment_count: segments.length, correction_revision: revision });
    return { source: updated, extracted };
  }
}

function createMultimodalManifest({ sha256, definition }) {
  return {
    contract_version: "1.0", format: definition.media, source_identity: { sha256, mime: definition.mime, parser: { name: definition.parser, version: "1" } },
    privacy: { processing: "local_only", external_authorized: false }, capabilities: MULTIMODAL_CAPABILITIES.media[definition.media],
    locator_contract: { page: "positive integer", region: "normalized x/y/width/height", time_range: "start_ms/end_ms", keyframe: "time_ms" },
    evidence_kinds: MULTIMODAL_CAPABILITIES.evidence_kinds, segments: [], text: "",
    review: { state: "pending_review", reasons: ["extractor_not_implemented"] },
    findings: [{ code: "EXTRACTION_PENDING", state: "pending_review", message: "Stage 1 registers the immutable source and evidence contract; OCR, transcription, and video understanding are not implemented." }]
  };
}

export function extractMarkdown(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const segments = [];
  let heading = "Document";
  let start = 1;
  let buffer = [];
  const flush = (end) => {
    const content = buffer.join("\n").trim();
    if (content) segments.push({ locator: `line:${start}-${end}`, heading, text: content });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) { flush(index); heading = match[2].trim(); start = index + 1; buffer.push(line); }
    else buffer.push(line);
  });
  flush(lines.length);
  return { format: "markdown", text: lines.join("\n").trim(), segments };
}

async function extractOpenXml(contents, parser, limits) {
  let archive;
  try { archive = await JSZip.loadAsync(contents, { checkCRC32: true, createFolders: false }); }
  catch { throw intakeError("INVALID_ARCHIVE", `invalid ${parser.toUpperCase()} archive`); }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > limits.maxEntries) throw intakeError("ARCHIVE_ENTRY_LIMIT", "archive has too many entries");
  let expanded = 0;
  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    if (isUnsafeArchivePath(original)) throw intakeError("ZIP_SLIP", `unsafe archive path: ${original}`);
    const size = entry._data?.uncompressedSize;
    if (Number.isFinite(size)) {
      if (size > limits.maxEntryBytes) throw intakeError("ARCHIVE_ENTRY_TOO_LARGE", `archive entry is too large: ${entry.name}`);
      expanded += size;
      if (expanded > limits.maxExpandedBytes) throw intakeError("ARCHIVE_EXPANDED_LIMIT", "archive expands beyond the configured limit");
    }
  }
  verifyOpenXmlPackage(archive, parser);
  return parser === "docx" ? extractDocx(archive) : extractPptx(archive);
}

async function extractDocx(archive) {
  const xml = await archive.file("word/document.xml").async("string");
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((match) => xmlText(match[1])).filter(Boolean);
  return { format: "docx", text: paragraphs.join("\n"), segments: paragraphs.map((text, index) => ({ locator: `/document/paragraph/${index + 1}`, text })) };
}

async function extractPptx(archive) {
  const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(naturalSlideOrder);
  const segments = [];
  for (const [slideIndex, file] of slides.entries()) {
    const xml = await archive.file(file).async("string");
    const shapes = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).filter(Boolean);
    shapes.forEach((text, shapeIndex) => segments.push({ locator: `/slides/${slideIndex + 1}/text/${shapeIndex + 1}`, slide: slideIndex + 1, text }));
  }
  return { format: "pptx", text: segments.map(({ text }) => text).join("\n"), segments };
}

function verifySignature(contents, parser) {
  if (["png", "jpeg", "wav", "mp3", "mp4", "webm"].includes(parser)) return verifyMediaSignature(contents, parser);
  if (parser === "markdown") {
    if (contents.includes(0)) throw intakeError("MIME_MISMATCH", "Markdown source contains binary data");
    return;
  }
  if (contents[0] !== 0x50 || contents[1] !== 0x4b) throw intakeError("MIME_MISMATCH", `${parser.toUpperCase()} source is not an Open XML ZIP package`);
}
function throwIfAborted(signal) { if (signal?.aborted) throw intakeError("SOURCE_IMPORT_CANCELLED", "source import was cancelled; retrying is safe and resumes from immutable content-addressed files"); }
function verifyMediaSignature(contents, signature) {
  const ascii = (start, end) => contents.subarray(start, end).toString("ascii");
  const valid = signature === "png" ? contents.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : signature === "jpeg" ? contents[0] === 0xff && contents[1] === 0xd8 && contents.at(-2) === 0xff && contents.at(-1) === 0xd9
    : signature === "wav" ? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE"
    : signature === "mp3" ? ascii(0, 3) === "ID3" || (contents[0] === 0xff && (contents[1] & 0xe0) === 0xe0)
    : signature === "mp4" ? ascii(4, 8) === "ftyp"
    : signature === "webm" ? contents.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) : false;
  if (!valid) throw intakeError("MIME_MISMATCH", `file signature does not match ${signature}`);
}
function verifyOpenXmlPackage(archive, parser) {
  const required = parser === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!archive.file("[Content_Types].xml") || !archive.file(required)) throw intakeError("MIME_MISMATCH", `archive is not a ${parser.toUpperCase()} package`);
}
function isUnsafeArchivePath(name) { return path.posix.isAbsolute(name) || name.split(/[\\/]+/).includes(".."); }
function xmlText(xml) { return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1])).join(""); }
function decodeXml(value) { return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&apos;", "'"); }
function naturalSlideOrder(left, right) { return Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]); }
async function writeImmutable(root, relativePath, contents) {
  const file = resolveProjectPath(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, contents, { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
function intakeError(code, message) { return Object.assign(new Error(message), { code }); }
function validateSegments(segments) {
  if (!Array.isArray(segments) || segments.some((segment) => typeof segment?.locator !== "string" || !segment.locator || typeof segment?.text !== "string")) throw intakeError("INVALID_CORRECTION", "segments require non-empty locators and text strings");
}

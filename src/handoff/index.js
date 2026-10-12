import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readDeliverySelection } from "../delivery/selection.js";
import { outputDir } from "../core/project.js";
import { SCRIPT_REVIEW_JSON, SCRIPT_REVIEW_MARKDOWN, renderScriptReviewMarkdown, reviewSpeakerScript } from "../qa/speaker-script.js";

export const HANDOFF_DIR = "handoff";
export const HANDOFF_MANIFEST_FILE = "manifest.json";

export async function createHandoff(project, reviewReport, options = {}) {
  if (!options.deliverySelection?.id) throw Object.assign(new Error("handoff requires an explicit stored delivery selection"), { code: "DELIVERY_SELECTION_REQUIRED" });
  const selection = await readDeliverySelection(project.root, options.deliverySelection.id);
  if (selection.artifact_type !== "presentation") throw Object.assign(new Error("handoff requires a presentation selection"), { code: "DELIVERY_SELECTION_MISMATCH" });
  const outputs = outputDir(project);

  const sourceFiles = (options.sourceFiles ?? await availableOutputFiles(outputs)).filter(source => source.name === "review-report.json" || selection.formats.some(format => source.name === `slides.${format}`));
  if (selection.formats.some(format => format !== "handout" && !sourceFiles.some(source => source.name === `slides.${format}`))) throw Object.assign(new Error("a selected artifact is missing"), { code: "EXPORTER_UNAVAILABLE" });
  const packageDir = await nextPackageDirectory(outputs);
  await fs.mkdir(packageDir, { recursive: true });
  sourceFiles.sort((left, right) => left.name.localeCompare(right.name));
  const packagedOutputs = [];
  for (const source of sourceFiles) {
    const destination = path.join(packageDir, source.name);
    await fs.copyFile(source.path, destination, constants.COPYFILE_EXCL);
    const contents = await fs.readFile(destination);
    packagedOutputs.push({
      name: source.name,
      source: path.relative(project.root, source.path),
      packaged: path.relative(project.root, destination),
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  }
  const scriptReview = await packageScriptReview(project, outputs, packageDir);
  if (scriptReview) packagedOutputs.push(...scriptReview.outputs);
  // The handout is an optional, independently selected target derived from the reviewed HTML.
  let handout;
  if (selection.formats.includes("handout")) {
    if (typeof options.handout !== "function") throw Object.assign(new Error("handout requires a reviewed HTML source"), { code: "EXPORTER_UNAVAILABLE" });
    handout = await options.handout(packageDir, selection.handout_options?.editions ?? ["speaker"]);
    packagedOutputs.push(...handout.files.map(({ name, path: file, bytes, sha256 }) => ({ name, source: "generated:handout", packaged: path.relative(project.root, file), bytes, sha256 })));
  }
  const accessibility = accessibilityHandoff(reviewReport);
  const factLedger = factLedgerHandoff(reviewReport);
  const citations = citationHandoff(reviewReport);

  const manifest = {
    schema_version: "0.1",
    command: "handoff",
    project: project.project.name,
    source_outputs_preserved: true,
    outputs: packagedOutputs,
    acceptance: reviewReport.summary,
    review: {
      passed: reviewReport.passed,
      required_failure_count: reviewReport.required_failure_count
    },
    delivery_selection: selection,
    ...(options.variant ? { variant: options.variant } : {}),
    ...(options.corporateProfile ? { corporate_profile: options.corporateProfile } : {}),
    ...(accessibility ? { accessibility } : {}),
    ...(factLedger ? { fact_ledger: factLedger } : {}),
    ...(citations ? { citations } : {}),
    ...(scriptReview ? { script_review: scriptReview.summary } : {}),
    ...(handout ? { handout: handout.summary } : {})
  };
  const manifestFile = path.join(packageDir, HANDOFF_MANIFEST_FILE);
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { manifest, manifestFile, packageDir };
}

// Saves the speaker script audit log beside the packaged outputs. A saved `pptops script-review` result is reused
// only when it was produced from the same script revision, which preserves its baseline compression evidence.
async function packageScriptReview(project, outputs, packageDir) {
  let review = reviewSpeakerScript(project, { includeScript: true });
  if (!review) return undefined;
  try {
    const saved = JSON.parse(await fs.readFile(path.join(outputs, SCRIPT_REVIEW_JSON), "utf8"));
    if (saved?.kind === "speaker_script_review" && saved.script_revision === review.script_revision && saved.project === review.project) review = saved;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const files = [[SCRIPT_REVIEW_JSON, `${JSON.stringify(review, null, 2)}\n`], [SCRIPT_REVIEW_MARKDOWN, renderScriptReviewMarkdown(review)]];
  const packaged = [];
  for (const [name, contents] of files) {
    const destination = path.join(packageDir, name);
    await fs.writeFile(destination, contents, { flag: "wx" });
    packaged.push({ name, source: "generated:speaker-script-review", packaged: path.relative(project.root, destination), bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") });
  }
  return {
    outputs: packaged,
    summary: { status: review.status, script_revision: review.script_revision, summary: review.summary, audit: { deleted_pages: review.audit.deleted_pages, skipped_pages: review.audit.skipped_pages, merged_pages: review.audit.merged_pages, compression_ratio: review.audit.compression_ratio, compression_basis: review.audit.compression_basis, budget_ratio: review.audit.budget_ratio ?? null, banned_phrase_counts: review.audit.banned_phrase_counts, dash_count: review.audit.dash_count }, files: packaged.map(({ name }) => name) }
  };
}

function citationHandoff(reviewReport) {
  const evidence = reviewReport.automated_checks?.find(({ id }) => id === "citation-manifest")?.evidence;
  if (!evidence) return undefined;
  return { citation_manifest_revision: evidence.citation_manifest_revision, fact_ledger_revision: evidence.fact_ledger_revision, disclosure: evidence.disclosure, status: evidence.status, unresolved_metadata: evidence.unresolved_metadata, hyperlink_inspection: evidence.hyperlink_inspection, fact_validity_is_separate: true };
}
function factLedgerHandoff(reviewReport) {
  const evidence = reviewReport.automated_checks?.find(({ id }) => id === "fact-ledger")?.evidence;
  if (!evidence) return undefined;
  return {
    ledger_revision: evidence.ledger_revision,
    evaluated_at: evidence.evaluated_at,
    status: evidence.status,
    summary: evidence.summary,
    blocker_claim_ids: evidence.blocker_claim_ids,
    claims: evidence.claims
  };
}

function accessibilityHandoff(reviewReport) {
  const audit = reviewReport.automated_checks?.find(({ id }) => id === "accessibility-audit")?.evidence;
  if (!audit) return undefined;
  return {
    declared_profile: audit.declared_profile,
    source_revision: audit.source_revision,
    build_revision: audit.build_revision,
    status: audit.status,
    unresolved_findings: audit.findings,
    format_capabilities: audit.format_capabilities,
    artifact_audits: audit.artifacts ?? [],
    evidence: audit.evidence,
    claims: audit.claims
  };
}

async function availableOutputFiles(outputs) {
  let entries;
  try {
    entries = await fs.readdir(outputs, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, path: path.join(outputs, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function nextPackageDirectory(outputs) {
  const handoffRoot = path.join(outputs, HANDOFF_DIR);
  await fs.mkdir(handoffRoot, { recursive: true });
  for (let number = 1; ; number += 1) {
    const candidate = path.join(handoffRoot, `package-${String(number).padStart(3, "0")}`);
    try {
      await fs.access(candidate);
    } catch (error) {
      if (error.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

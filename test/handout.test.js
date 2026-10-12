import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ApplicationService } from "../src/application/service.js";
import { buildHtml } from "../src/adapters/html.js";
import { initializeProject } from "../src/core/init.js";
import { readProject } from "../src/core/project.js";
import { exportHandout, normalizeHandoutEditions } from "../src/delivery/handout.js";
import { hashFile } from "../src/delivery/pdf.js";
import { deliveryCapabilities, readDeliverySelection, recordDeliverySelection } from "../src/delivery/selection.js";
import { writeMigratedProject } from "../src/migrations/foundation-to-v1.js";
import { countPdfPages, inspectPdfPageConsistency, pdfTextLayer } from "../src/qa/content-consistency.js";
import { findBrowser } from "../src/qa/html.js";
import { reviewSpeakerScript } from "../src/qa/speaker-script.js";
import { seedAcceptedBoundaryImages } from "./support/accepted-boundaries.js";

process.env.PPT_OPS_RENDER_QA = "0";
const execFileAsync = promisify(execFile);
const cli = path.resolve("src/cli.js");
const demo = path.resolve("examples/demo-project");

test("PDF page consistency reuses the slide extraction and requires a real text layer", async t => {
  const root = await temporary(t);
  const html = path.join(root, "slides.html");
  await fs.writeFile(html, ["one", "two", "three"].map((title, index) => `<section class="slide" data-page="${index + 1}"><h1 data-reading-key="title">${title}</h1></section>`).join(""));
  const page = "<< /Type /Page /Resources << /Font << /F1 5 0 R >> >> >>";
  const textPdf = Buffer.from(`%PDF-1.4\n${page}\n${page}\n${page}\nstream\nBT /F1 12 Tf (x) Tj ET\nendstream\n%%EOF`);
  assert.equal(countPdfPages(textPdf), 3);
  assert.equal(pdfTextLayer(textPdf), "present");
  const passed = await inspectPdfPageConsistency({ htmlFile: html, pdfBytes: textPdf });
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.page_count, { html: 3, omitted: 0, expected: 3, pdf: 3 });
  const omitted = await inspectPdfPageConsistency({ htmlFile: html, pdfBytes: textPdf, omitPages: [2] });
  assert.equal(omitted.findings[0].rule, "page-count-mismatch");
  const imageOnly = Buffer.from(`%PDF-1.4\n${"<< /Type /Page >>\n".repeat(3)}stream\nq 100 0 0 100 0 0 cm /Im1 Do Q\nendstream\n%%EOF`);
  const raster = await inspectPdfPageConsistency({ htmlFile: html, pdfBytes: imageOnly });
  assert.equal(raster.status, "failed");
  assert.equal(raster.findings[0].rule, "pdf-text-layer-missing");
});

test("handout is an optional delivery format selected independently of HTML and PPTX", async t => {
  const root = await temporary(t);
  const base = { artifact_type: "presentation", source_id: "build-001", source_revision: "version-001", actor: "user" };
  const defaults = await recordDeliverySelection(root, { ...base, formats: ["html", "pptx"], available_formats: ["html", "pptx"] });
  assert.equal("handout_options" in defaults.decision, false);
  await assert.rejects(recordDeliverySelection(root, { ...base, formats: ["handout"], available_formats: ["html", "pptx"] }), { code: "EXPORTER_UNAVAILABLE" });
  const only = await recordDeliverySelection(root, { ...base, formats: ["handout"], available_formats: ["html", "handout"] });
  assert.deepEqual(only.decision.handout_options, { editions: ["speaker"] });
  const both = await recordDeliverySelection(root, { ...base, formats: ["pptx", "handout"], available_formats: ["pptx", "handout"], handout_options: { editions: ["audience", "speaker"] } });
  assert.deepEqual((await readDeliverySelection(root, both.decision.id)).handout_options.editions, ["speaker", "audience"]);
  await assert.rejects(recordDeliverySelection(root, { ...base, formats: ["handout"], available_formats: ["handout"], handout_options: { editions: ["vip"] } }), { code: "DELIVERY_FORMAT_INVALID" });
  assert.throws(() => normalizeHandoutEditions([]), { code: "HANDOUT_EDITION_INVALID" });
  const capabilities = deliveryCapabilities({ artifactType: "presentation", availableFormats: ["html", "pptx"] });
  assert.deepEqual(capabilities.map(({ format, status }) => [format, status]), [["html", "available"], ["pptx", "available"], ["pdf", "unavailable"], ["handout", "unavailable"]]);
});

test("without Chromium the handout records PDF and previews as unavailable and still writes script and index", async t => {
  const root = await temporary(t);
  const project = await scriptedDemo(root);
  const htmlFile = path.join(root, "slides.html");
  await fs.writeFile(htmlFile, await buildHtml(project));
  const packageDir = path.join(root, "package-001");
  await fs.mkdir(packageDir);
  const citationManifest = { revision: "cite-rev", citations: [
    { id: "cite-001", number: 1, disclosure: "public", channels: ["appendix"], status: "ready", author_or_organization: "Example Org", title: "Annual Report", date: "2026", url: "https://example.com/report" },
    { id: "cite-002", number: 2, disclosure: "restricted", channels: ["internal_only"], status: "internal_only", title: null }
  ] };
  const { summary, files } = await exportHandout({ project, htmlFile, packageDir, scriptReview: reviewSpeakerScript(project, { includeScript: true, force: true }), editions: ["speaker", "audience"], citationManifest, source: { kind: "test" } }, { findBrowser: async () => undefined });
  assert.equal(summary.status, "incomplete");
  assert.equal(summary.components.pdf.status, "unavailable");
  assert.equal(summary.components.previews.status, "unavailable");
  assert.equal(summary.audience.pdf.status, "unavailable");
  assert.equal(files.some(({ name }) => name.endsWith(".pdf") || name.endsWith(".png")), false);
  const script = await fs.readFile(path.join(packageDir, "handout", "script.md"), "utf8");
  assert.deepEqual([...script.matchAll(/^## (\d+)\. (.*)$/gm)].map(match => match[2]), project.pages.map(page => page.screen_text.title));
  assert.match(script, /先说这套流程为什么可控。/);
  assert.equal(summary.checks.find(({ id }) => id === "handout-script-titles").status, "passed");
  assert.ok(summary.pages.every(page => /^[0-9a-f]{64}$/.test(page.page_spec_sha256)));
  assert.deepEqual(summary.audience.merged_transitions, [{ page: 2, merged_into: 3 }]);
  assert.equal(summary.audience.speaker_notes, "excluded");
  assert.deepEqual(summary.audience.citations.count, 1);
  const audienceIndex = await fs.readFile(path.join(packageDir, "handout", "audience", "index.html"), "utf8");
  assert.match(audienceIndex, /Annual Report/);
  assert.doesNotMatch(audienceIndex, /restricted|先说这套流程/);
  await assert.rejects(fs.access(path.join(packageDir, "handout", "audience", "script.md")));
  const index = await fs.readFile(path.join(packageDir, "handout", "index.html"), "utf8");
  assertOffline(index);
  assert.match(index, /PDF 不可用/);
});

test("formal handoff packages a vector PDF, previews, chapter index and audience edition for an audience variant", async t => {
  if (!await findBrowser()) { t.skip("Chromium is unavailable; the unavailable-status path is covered separately"); return; }
  const { root, service } = await formalFixture(t);
  const base = await service.freezeVersion();
  const state = await service.manageAudienceVariants("list");
  await service.manageAudienceVariants("save", { variant: { id: "listeners", title: "Listener version", audience: "students", purpose: "Share after the talk", expected_duration_seconds: 600, delivery_mode: "live_talk", base: { project_id: "handout-project", revision: base.id }, page_ids: ["page-001", "page-002", "page-003", "page-005"], page_overrides: [{ page_id: "page-003", patch: { screen_text: { title: "Renamed for listeners" } } }], section_overrides: [] }, expected_revision: state.revision, actor: "user", raw_feedback: "Accept the listener version" });
  const version = await service.freezeVersion({ variantId: "listeners" });
  const { build } = await service.createBuild({ versionId: version.id, targets: ["html"] });
  const select = (formats, editions) => service.selectDelivery({ artifactType: "presentation", formats, sourceId: build.id, sourceRevision: version.id, actor: "user", buildId: build.id, handoutEditions: editions });
  await assert.rejects(select(["handout"]), { code: "EXPORTER_UNAVAILABLE" });
  const { review } = await service.runReview(build.id);
  const accepted = await service.recordReview(review.id, { decision: "accepted", expectedRevision: review.revision, evidence: { source: "synthetic handout fixture" } });
  const capability = (await service.deliveryCapabilities("presentation", build.id)).find(({ format }) => format === "handout");
  assert.equal(capability.status, "available");
  assert.equal(capability.components.pdf.status, "available");
  const selection = await select(["handout"], ["speaker", "audience"]);
  const result = await service.createHandoff(build.id, accepted.id, { deliverySelectionId: selection.decision.id });
  const manifest = JSON.parse(await fs.readFile(result.manifest_file, "utf8"));
  assert.equal(manifest.outputs.some(({ name }) => name === "slides.html"), false);
  const handout = manifest.handout;
  assert.equal(handout.status, "complete", JSON.stringify(handout.checks));
  assert.deepEqual(handout.source.variant, version.variant);
  assert.equal(handout.source.version_id, version.id);
  assert.equal(handout.source.version_snapshot_sha256, await hashFile(path.join(root, `.pptops/versions/${version.id}/snapshot.json`)));
  assert.deepEqual(handout.pages.map(({ id }) => id), ["page-001", "page-002", "page-003", "page-005"]);
  assert.equal(handout.pages[2].title, "Renamed for listeners");
  assert.deepEqual(handout.chapters.map(({ title, pages }) => [title, pages]), [["Opening", [1, 2]], ["Method", [3, 4]]]);
  assert.deepEqual(handout.components.pdf.page_count, { html: 4, omitted: 0, expected: 4, pdf: 4 });
  assert.equal(handout.components.pdf.text_layer, "present");
  assert.deepEqual(handout.audience.pdf.page_count, { html: 4, omitted: 1, expected: 3, pdf: 3 });
  assert.equal(handout.components.previews.count, 4);
  const dir = path.join(result.package_dir, "handout");
  for (const page of handout.pages) {
    const png = await fs.readFile(path.join(result.package_dir, page.preview));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(page.preview_sha256, await hashFile(path.join(result.package_dir, page.preview)));
  }
  const script = await fs.readFile(path.join(dir, "script.md"), "utf8");
  assert.deepEqual([...script.matchAll(/^## (\d+)\. (.*)$/gm)].map(match => match[2]), ["Page 1", "Page 2", "Renamed for listeners", "Page 5"]);
  const index = await fs.readFile(path.join(dir, "index.html"), "utf8");
  assertOffline(index);
  for (const src of [...index.matchAll(/src="([^"]+)"/g)].map(match => match[1])) await fs.access(path.join(dir, src));
  const audienceIndex = await fs.readFile(path.join(dir, "audience", "index.html"), "utf8");
  for (const src of [...audienceIndex.matchAll(/src="([^"]+)"/g)].map(match => match[1])) await fs.access(path.join(dir, "audience", src));
  assert.doesNotMatch(audienceIndex, /Page 2</);
  assert.ok(manifest.outputs.some(({ name }) => name === "handout/audience/slides.pdf"));
  await fs.appendFile(path.join(root, selection.decision.handout_source.file), "<!-- changed -->");
  await assert.rejects(service.createHandoff(build.id, accepted.id, { deliverySelectionId: selection.decision.id }), { code: "HANDOUT_SOURCE_CHANGED" });
});

test("deliver --formats handout renders HTML as the source without packaging it", async t => {
  const root = await temporary(t);
  const projectDir = path.join(root, "project");
  await scriptedDemo(projectDir);
  await execFileAsync(process.execPath, [cli, "script-review", projectDir], { encoding: "utf8" }).catch(error => error);
  const { stdout } = await execFileAsync(process.execPath, [cli, "deliver", projectDir, "--formats", "handout", "--actor", "user:fixture", "--handout-editions", "speaker,audience"], { encoding: "utf8", env: { ...process.env, PPT_OPS_RENDER_QA: "0" } }).catch(error => error);
  const manifest = JSON.parse(stdout);
  assert.deepEqual(manifest.delivery_selection.formats, ["handout"]);
  assert.equal(manifest.outputs.some(({ name }) => name === "slides.html"), false);
  assert.equal(manifest.handout.source.kind, "legacy_output_snapshot");
  assert.equal(manifest.handout.source.script_source, "outputs/script-review.json");
  assert.ok(manifest.outputs.some(({ name }) => name === "handout/script.md"));
  assert.ok(manifest.outputs.some(({ name }) => name === "handout/audience/index.html"));
  const expected = await findBrowser() ? "generated" : "unavailable";
  assert.equal(manifest.handout.components.pdf.status, expected);
  if (expected === "generated") assert.equal(manifest.handout.components.pdf.page_count.pdf, 3);
});

async function scriptedDemo(projectDir) {
  await writeMigratedProject(demo, projectDir);
  await seedAcceptedBoundaryImages(projectDir);
  const projectFile = path.join(projectDir, "project.json"), pagesFile = path.join(projectDir, "pages.json");
  const contract = JSON.parse(await fs.readFile(projectFile, "utf8"));
  await fs.writeFile(projectFile, JSON.stringify({ ...contract, talk_budget: { total_minutes: 1 } }));
  const pages = JSON.parse(await fs.readFile(pagesFile, "utf8"));
  const transition = { ...structuredClone(pages[1]), id: "page-transition", page: 2, script_role: "transition", screen_text: { title: "接下来看两种载体" }, speaker_notes: "先说这套流程为什么可控。" };
  pages[0].speaker_notes = "这是开场。";
  pages[1] = { ...pages[1], page: 3, speaker_notes: "HTML 用来快速试错，PPTX 用来正式交付。" };
  pages.splice(1, 0, transition);
  await fs.writeFile(pagesFile, JSON.stringify(pages));
  const outlineFile = path.join(projectDir, "outline.json");
  try {
    const outline = JSON.parse(await fs.readFile(outlineFile, "utf8"));
    outline.sections[0].page_ids.splice(1, 0, "page-transition");
    await fs.writeFile(outlineFile, JSON.stringify(outline));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return readProject(projectDir);
}

async function formalFixture(t) {
  const root = path.join(await temporary(t), "project");
  await initializeProject(root, { name: "handout-project", title: "Handout project" });
  const first = JSON.parse(await fs.readFile(path.join(root, "pages.json")))[0];
  const pages = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(first), id: `page-00${index + 1}`, page: index + 1, screen_text: { title: `Page ${index + 1}` }, speaker_notes: `第 ${index + 1} 页讲稿。`, ...(index === 1 ? { script_role: "transition" } : {}) }));
  const outline = JSON.parse(await fs.readFile(path.join(root, "outline.json")));
  outline.sections = [{ id: "section-opening", title: "Opening", page_ids: ["page-001", "page-002"] }, { id: "section-method", title: "Method", page_ids: ["page-003", "page-004", "page-005"] }];
  await fs.writeFile(path.join(root, "pages.json"), JSON.stringify(pages));
  await fs.writeFile(path.join(root, "outline.json"), JSON.stringify(outline));
  const projectFile = path.join(root, "project.json");
  await fs.writeFile(projectFile, JSON.stringify({ ...JSON.parse(await fs.readFile(projectFile, "utf8")), talk_budget: { total_minutes: 2 } }));
  await seedAcceptedBoundaryImages(root);
  const service = await ApplicationService.open(root);
  t.after(() => { try { service.close(); } catch {} });
  return { root, service };
}

function assertOffline(html) {
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  assert.doesNotMatch(html, /<script\b/);
}

async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-handout-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

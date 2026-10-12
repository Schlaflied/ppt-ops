import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPptx } from "../src/adapters/pptx.js";
import { DELIVERY_MODES, densityGuidanceFor, inspectDeliveryModeFit } from "../src/contracts/delivery.js";
import { LIVE_TALK_MINIMUM_BODY_FONT_PX, ONLINE_LECTURE_LEGIBILITY, SAFE_ZONE_PRESETS, inspectInteractionCadence, resolveSafeZones, validateOnlineLectureProjectFields } from "../src/contracts/online-lecture.js";
import { validateV1Entity } from "../src/contracts/v1.js";
import { readProject } from "../src/core/project.js";
import { validateProject } from "../src/core/validate.js";
import { migrateFoundationProject } from "../src/migrations/foundation-to-v1.js";
import { inspectPptxStructure, renderPresentation } from "../src/qa/index.js";
import { inspectHtmlPresentation } from "../src/qa/html.js";
import { analyzeOnlineLecture, extractPptxOnlineElements } from "../src/qa/online-lecture.js";
import { analyzeScreenshotEvidence } from "../src/qa/screenshot-evidence.js";

const v1Project = (overrides = {}) => ({
  contract_version: "1.0", kind: "project", id: "demo", title: "Demo", format: "16:9",
  source_ids: ["source-001"], outline_id: "outline-main", theme_id: "theme-default", asset_ids: [],
  delivery_mode: "online_lecture", ...overrides
});

test("online_lecture is a delivery mode in validators and every schema enumeration", async () => {
  assert.ok(DELIVERY_MODES.includes("online_lecture"));
  for (const file of ["schemas/project.schema.json", "schemas/v1/project.schema.json", "schemas/audience-variants.schema.json"]) {
    assert.match(await fs.readFile(file, "utf8"), /"online_lecture"/, file);
  }
  assert.deepEqual(validateV1Entity(v1Project({ safe_zones: [{ preset: "zoom" }, { name: "chat-panel", x: 0.8, y: 0, width: 0.2, height: 1 }], interaction_interval_minutes: 10 }), "project"), []);
  const errors = validateV1Entity(v1Project({ safe_zones: [{ preset: "webex" }, { name: "Bad Name", x: 0.9, y: 0, width: 0.2, height: 1 }], interaction_interval_minutes: 0 }), "project");
  assert.ok(errors.includes("safe_zones[0].preset is invalid: webex"));
  assert.ok(errors.includes("safe_zones[1].name must be a stable lowercase identifier"));
  assert.ok(errors.includes("safe_zones[1] must be a normalized rectangle inside 0..1"));
  assert.ok(errors.includes("interaction_interval_minutes must be a number between 0 and 60"));
  assert.deepEqual(validateOnlineLectureProjectFields({ safe_zones: [{ preset: "zoom", x: 0 }] }), ["safe_zones[0] must declare either preset or a rectangle"]);
});

test("Foundation projects accept online_lecture safe zones and migration preserves them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-online-lecture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve("examples/demo-project"), root, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  Object.assign(manifest, { delivery_mode: "online_lecture", safe_zones: [{ preset: "feishu" }], interaction_interval_minutes: 9 });
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify(manifest));
  const project = await readProject(root);
  assert.deepEqual(validateProject(project), []);
  project.project.safe_zones = [{ preset: "unknown" }];
  assert.ok(validateProject(project).includes("project.safe_zones[0].preset is invalid: unknown"));
  const { bundle } = await migrateFoundationProject(root);
  assert.deepEqual(bundle.project.safe_zones, [{ preset: "feishu" }]);
  assert.equal(bundle.project.interaction_interval_minutes, 9);
});

test("online_lecture guidance is stricter than live_talk", () => {
  const online = densityGuidanceFor("online_lecture");
  const live = densityGuidanceFor("live_talk");
  assert.ok(online.character_limit < live.character_limit);
  assert.ok(online.shape_limit < live.shape_limit);
  assert.ok(online.minimum_body_font_px > LIVE_TALK_MINIMUM_BODY_FONT_PX);
  const dense = { page: 2, three_second_message: "Message", screen_text: { title: "Dense", body: ["x".repeat(350)] } };
  const fit = inspectDeliveryModeFit({ project: { delivery_mode: "online_lecture", safe_zones: [] }, pages: [{ page: 1, screen_text: { title: "Open" } }, dense, { page: 3, screen_text: { title: "Close" } }] });
  assert.equal(fit.status, "failed");
  assert.deepEqual(fit.findings.map(({ page, check }) => [page, check]), [[2, "delivery-mode-density"], [null, "online-lecture-duration-unestimated"]]);
  assert.equal(fit.findings[0].evidence.character_limit, 300);
  assert.equal(inspectDeliveryModeFit({ project: { delivery_mode: "live_talk" }, pages: [dense] }).status, "passed");
});

test("safe-zone presets cover at least three meeting apps with named normalized rectangles", () => {
  for (const preset of ["tencent_meeting", "zoom", "feishu"]) assert.ok(SAFE_ZONE_PRESETS[preset].zones.length >= 2);
  const zones = resolveSafeZones([{ preset: "tencent_meeting" }, { name: "chat-panel", x: 0.8, y: 0, width: 0.2, height: 1 }]);
  assert.deepEqual(zones.map(({ name }) => name), ["tencent_meeting.share_toolbar", "tencent_meeting.self_view", "chat-panel"]);
  for (const zone of zones) assert.ok(zone.x >= 0 && zone.y >= 0 && zone.x + zone.width <= 1 && zone.y + zone.height <= 1);
});

test("interaction cadence reports gaps longer than the configured interval", () => {
  const pages = Array.from({ length: 8 }, (_, index) => ({ page: index + 1, estimated_duration_seconds: 120, screen_text: { title: `P${index + 1}` } }));
  const gap = inspectInteractionCadence(pages, { intervalMinutes: 8 });
  assert.deepEqual(gap.findings.map(({ page, check, evidence }) => [page, check, evidence.gap_start_page, evidence.gap_end_page, evidence.gap_seconds, evidence.interval_seconds]),
    [[5, "online-lecture-interaction-cadence", 1, 8, 960, 480]]);
  pages[3].audience_interaction = { kind: "question", intent: "Poll the audience." };
  assert.deepEqual(inspectInteractionCadence(pages, { intervalMinutes: 8 }).findings, []);
  assert.equal(inspectInteractionCadence(pages, { intervalMinutes: 5 }).findings.length, 2);

  const fit = inspectDeliveryModeFit({ project: { delivery_mode: "online_lecture", interaction_interval_minutes: 5 }, pages });
  assert.equal(fit.status, "failed");
  assert.equal(fit.online_lecture.interaction_interval_minutes, 5);
  assert.ok(fit.findings.some(({ check }) => check === "online-lecture-safe-zones-undeclared"));
  const relaxed = inspectDeliveryModeFit({ project: { delivery_mode: "online_lecture", interaction_interval_minutes: 10 }, pages });
  assert.equal(relaxed.status, "passed", "note-level findings do not fail delivery-mode fit");
});

test("online-lecture analysis reports occlusion, 720p font, contrast and thin lines with page and element ids", () => {
  const result = analyzeOnlineLecture([{
    page: 4,
    elements: [
      { id: "legend", key: true, rect: { x: 0.82, y: 0.8, width: 0.15, height: 0.1 }, text: { font_px: 36, secondary: false, foreground: "#202124", background: "#FFFFFF" } },
      { id: "caption", key: true, rect: { x: 0.1, y: 0.4, width: 0.3, height: 0.05 }, text: { font_px: 26, secondary: false, foreground: "#AAAAAA", background: "#FFFFFF" } },
      { id: "footnote", key: false, rect: { x: 0.85, y: 0.9, width: 0.1, height: 0.05 }, text: { font_px: 20, secondary: true } }
    ],
    strokes: [{ id: "trend-line", stroke_px: 2 }, { id: "axis", stroke_px: 4 }]
  }], { safeZones: resolveSafeZones([{ preset: "tencent_meeting" }]) });
  const summary = result.findings.map(({ page, check, evidence }) => [page, check, evidence.element, evidence.zone]);
  assert.deepEqual(summary, [
    [4, "online-safe-zone-occlusion", "legend", "tencent_meeting.self_view"],
    [4, "online-720p-font-size", "caption", undefined],
    [4, "online-720p-contrast", "caption", undefined],
    [4, "online-720p-thin-line", "trend-line", undefined]
  ]);
  const font = result.findings.find(({ check }) => check === "online-720p-font-size").evidence;
  assert.equal(font.font_px_720, 17.33);
  assert.equal(font.minimum_px_720, Number((ONLINE_LECTURE_LEGIBILITY.minimum_body_font_px * 2 / 3).toFixed(2)));
  assert.equal(result.view.evaluation_height_px, 720);
  assert.equal(result.human_readability_assessed, false);
});

test("PPTX online-lecture extraction maps runs, fills and connector widths to 1080p pixels", () => {
  const xml = `<p:sld><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Body text 1"></p:cNvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6095847" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="000000"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="50000"/></a:srgbClr></a:solidFill></a:rPr><a:t>Small</a:t></a:r></a:p></p:txBody></p:sp>
    <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="3" name="Diagram connector a to b"></p:cNvPr></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="0"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="6350"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:cxnSp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="Footer rule"></p:cNvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="0"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="6350"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const page = extractPptxOnlineElements(xml, 3);
  assert.deepEqual(page.elements.map(({ id, key, text }) => [id, key, text.font_px, text.foreground, text.background]), [["Body text 1", true, 24, "#808080", "#000000"]]);
  assert.deepEqual(page.elements[0].rect, { x: 0, y: 0, width: 6095847 / 12191695, height: 0.5 });
  assert.deepEqual(page.strokes, [{ id: "Diagram connector a to b", stroke_px: 6350 / (6858000 / 1080) }]);
});

test("generated PPTX for online_lecture reports elements under declared safe zones", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-online-pptx-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await readProject("examples/demo-project");
  project.project.delivery_mode = "online_lecture";
  project.project.safe_zones = [{ name: "left-half", x: 0, y: 0, width: 0.5, height: 1 }];
  project.assets = [];
  for (const page of project.pages) page.asset_slots = [];
  const pptxFile = path.join(root, "slides.pptx");
  await buildPptx(project, pptxFile);
  const result = await inspectPptxStructure(pptxFile, project);
  const occlusions = result.findings.filter(({ check }) => check === "online-safe-zone-occlusion");
  assert.ok(occlusions.length > 0);
  for (const { page, evidence } of occlusions) {
    assert.ok(Number.isInteger(page));
    assert.equal(evidence.zone, "left-half");
    assert.equal(typeof evidence.element, "string");
  }
  assert.ok(result.pages.every(({ checks }) => checks.includes("online-safe-zones") && checks.includes("online-720p-legibility")));
  assert.equal(result.online_lecture.view.evaluation_height_px, 720);
  assert.equal(result.screenshot_evidence.downscaled_views[0].height, 720);

  project.project.delivery_mode = "live_talk";
  const live = await inspectPptxStructure(pptxFile, project);
  assert.equal(live.online_lecture, undefined);
  assert.ok(!live.findings.some(({ check }) => check.startsWith("online-")));
});

test("screenshot evidence records focal-region size on the 720p view", () => {
  const project = {
    pages: [{ page: 2, asset_slots: [{ asset_id: "screen" }] }],
    assets: [{ id: "screen", screenshot_evidence: { content_role: "contextual", evidence_purpose: "Context", focal_region: { x: 0, y: 0, width: 0.5, height: 0.5 } } }]
  };
  const placement = { page: 2, asset_id: "screen", x: 0, y: 0, width: 12191695, height: 6858000 };
  const result = analyzeScreenshotEvidence(project, [placement], { downscaledViews: [720] });
  assert.deepEqual(result.downscaled_views, [{ height: 720, width: 1280, focal_regions: [{ page: 2, asset_id: "screen", width_px: 640, height_px: 360 }] }]);
  assert.equal(analyzeScreenshotEvidence(project, [placement]).downscaled_views, undefined);
});

test("rendering attaches 720p downscaled page images when requested", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-online-render-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = path.join(root, "tool");
  await fs.writeFile(tool, "");
  const evidenceDir = path.join(root, "evidence");
  const calls = [];
  const commands = {
    powerpoint: undefined, libreoffice: tool, pdftoppm: tool, magick: tool,
    exec: async (file, args) => {
      calls.push(args);
      if (args[0] === "--headless") await fs.writeFile(path.join(evidenceDir, "slides.pdf"), "pdf");
      else if (args[0] === "-png") await fs.writeFile(`${args.at(-1)}-1.png`, "png");
      else await fs.writeFile(args.at(-1), "png");
    }
  };
  const rendering = await renderPresentation({ pptxFile: path.join(root, "slides.pptx"), evidenceDir, commands, downscaleHeights: [720] });
  assert.equal(rendering.status, "rendered");
  assert.deepEqual(rendering.downscaled_views, [{ height: 720, width: 1280, status: "rendered", page_images: [path.join(evidenceDir, "page-720p-1.png")] }]);
  assert.ok(calls.some((args) => args.includes("1280x720!")));
  const plain = await renderPresentation({ pptxFile: path.join(root, "slides.pptx"), evidenceDir, commands });
  assert.equal(plain.downscaled_views, undefined);
});

test("headless HTML QA runs online-lecture checks on rendered DOM boxes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-online-html-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "deck.html");
  await fs.writeFile(file, `<!doctype html><style>body{margin:0}.slide{position:relative;width:1920px;height:1080px;background:#fff}.legend{position:absolute;left:1600px;top:900px;width:280px;font-size:40px;color:#111}.small{position:absolute;left:100px;top:400px;font-size:18px;color:#999}</style><section class="slide" data-page="3"><p class="legend" data-qa-id="legend">Legend</p><p class="small" data-qa-id="small">Tiny grey</p><svg width="400" height="100" style="position:absolute;left:100px;top:600px"><line data-qa-id="hairline" x1="0" y1="50" x2="400" y2="50" stroke="#000" stroke-width="1"/></svg></section>`);
  const result = await inspectHtmlPresentation({ htmlFile: file, onlineLecture: { safeZones: resolveSafeZones([{ preset: "tencent_meeting" }]), legibility: ONLINE_LECTURE_LEGIBILITY } });
  if (result.status === "degraded" && !result.online_lecture) return t.skip(result.reason);
  const online = result.findings.filter(({ check }) => check.startsWith("online-")).map(({ page, check, evidence }) => [page, check, evidence.element, evidence.zone]);
  assert.deepEqual(online, [
    [3, "online-safe-zone-occlusion", "legend", "tencent_meeting.self_view"],
    [3, "online-720p-font-size", "small", undefined],
    [3, "online-720p-contrast", "small", undefined],
    [3, "online-720p-thin-line", "hairline", undefined]
  ]);
});

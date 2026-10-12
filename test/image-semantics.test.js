import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { validateV1Bundle, validateV1Entity } from "../src/contracts/v1.js";
import { analyzeImageSemantics } from "../src/qa/image-semantics.js";

const digest = "a".repeat(64);
const base = (kind, id, fields = {}) => ({ contract_version: "1.0", kind, id, ...fields });
const semantics = {
  annotation_state: "machine_observed",
  semantic_regions: [
    { id: "warehouse", role: "workplace-scene", bounds: { x: 0, y: 0, width: 0.5, height: 1 } },
    { id: "clinic", role: "workplace-scene", bounds: { x: 0.5, y: 0, width: 0.5, height: 1 } }
  ],
  focal_points: [{ id: "clinic-worker", x: 0.75, y: 0.5 }],
  text_safe_areas: [{ id: "top-labels", bounds: { x: 0, y: 0, width: 1, height: 0.15 } }],
  anchor_edges: [{ id: "clinic-left", region_id: "clinic", edge: "left" }],
  minimum_display_size: { width: 0.4, height: 0.4 },
  forbidden_crops: [{ id: "keep-clinic", bounds: { x: 0.5, y: 0, width: 0.5, height: 1 } }]
};

test("V1 contracts bind page content to declared semantic regions and anchors", () => {
  const asset = base("asset", "multi-scene", { type: "image", file: "multi.png", sha256: digest, image_semantics: semantics });
  assert.deepEqual(validateV1Entity(asset, "asset"), []);
  const bundle = fixture(asset, [{ role: "hero", asset_id: asset.id, region_mappings: [{ content_id: "clinic-copy", region_id: "clinic", anchor_id: "clinic-left" }] }]);
  assert.deepEqual(validateV1Bundle(bundle), []);
  bundle.pages[0].asset_slots[0].region_mappings[0].region_id = "missing";
  assert.ok(validateV1Bundle(bundle).some((error) => error.includes("references missing region: missing")));
});

test("region mappings may carry a display label in both page-spec schemas and the V1 contract", async () => {
  const mapping = { content_id: "clinic-copy", region_id: "clinic", anchor_id: "clinic-left", label: "Clinic intake" };
  for (const file of ["schemas/page-spec.schema.json", "schemas/v1/page-spec.schema.json"]) {
    const schema = JSON.parse(await fs.readFile(file, "utf8"));
    const item = findRegionMappingItems(schema);
    assert.equal(item.additionalProperties, false, file);
    assert.deepEqual(Object.keys(mapping).filter((key) => !item.properties[key]), [], file);
    assert.deepEqual(item.properties.label, { type: "string", minLength: 1, maxLength: 80 }, file);
  }
  const asset = base("asset", "multi-scene", { type: "image", file: "multi.png", sha256: digest, image_semantics: semantics });
  const bundle = fixture(asset, [{ role: "hero", asset_id: asset.id, region_mappings: [mapping] }]);
  assert.deepEqual(validateV1Bundle(bundle), []);
  bundle.pages[0].asset_slots[0].region_mappings[0].label = "x".repeat(81);
  assert.ok(validateV1Bundle(bundle).some((error) => error.includes("label must be a string of 1–80 characters")));
});

test("contract rejects malformed regions, duplicate mappings and unknown anchor targets", () => {
  const asset = base("asset", "bad", { type: "image", file: "bad.png", sha256: digest, image_semantics: { ...semantics, semantic_regions: [{ id: "clinic", role: "scene", bounds: { x: 0.8, y: 0, width: 0.4, height: 1 } }], anchor_edges: [{ id: "bad-anchor", region_id: "missing", edge: "diagonal" }] } });
  const errors = validateV1Entity(asset, "asset");
  assert.ok(errors.some((error) => error.includes("x + width must not exceed 1")));
  assert.ok(errors.some((error) => error.includes("references missing semantic region")));
  assert.ok(errors.some((error) => error.includes("edge is invalid")));
});

test("QA reports missing mappings, unsafe crops and undersized placements without claiming comprehension", () => {
  const project = { assets: [{ id: "multi-scene", image_semantics: semantics }], pages: [{ page: 2, asset_slots: [{ asset_id: "multi-scene" }] }] };
  const result = analyzeImageSemantics(project, [{ page: 2, asset_id: "multi-scene", width: 3000000, height: 2000000, crop: { right: 0.3 } }]);
  assert.equal(result.status, "failed");
  assert.equal(result.pixel_semantics_inferred, false);
  assert.equal(result.human_comprehension_assessed, false);
  for (const check of ["image-semantics-human-confirmation", "image-region-mapping-missing", "image-minimum-display-size", "image-semantic-region-cropped", "image-forbidden-crop"]) assert.ok(result.findings.some((item) => item.check === check));
});

test("QA blocks crops outside allowed windows and labels outside text-safe areas", () => {
  const guarded = { ...semantics, allowed_crops: [{ id: "center", bounds: { x: 0.2, y: 0, width: 0.6, height: 1 } }] };
  const project = { assets: [{ id: "multi-scene", image_semantics: guarded }], pages: [{ page: 2, asset_slots: [{ asset_id: "multi-scene", region_mappings: [{ content_id: "clinic-copy", region_id: "clinic" }] }] }] };
  const result = analyzeImageSemantics(project, [{ page: 2, asset_id: "multi-scene", width: 6000000, height: 4000000, crop: { left: 0.1 }, overlays: [{ id: "label", x: 0.8, y: 0.8, width: 0.2, height: 0.2 }] }]);
  assert.equal(result.build_blocked, true);
  assert.equal(result.recommended_action, "switch-layout-or-request-review");
  assert.ok(result.findings.some(({ check }) => check === "image-crop-outside-allowed-region"));
  assert.ok(result.findings.some(({ check }) => check === "image-text-outside-safe-area"));
});

function fixture(asset, assetSlots) {
  const project = base("project", "demo", { title: "Demo", format: "16:9", outputs: ["pptx"], source_ids: ["source-001"], outline_id: "outline-main", theme_id: "theme-default", asset_ids: [asset.id] });
  const source = base("source", "source-001", { file: "brief.md", bytes: 1, mime: "text/markdown", sha256: digest });
  const page = base("page_spec", "page-001", { page: 1, task: "Compare", three_second_message: "Compare workplaces", relation: "comparison", screen_text: { title: "Compare" }, visual_job: "Map copy to regions", source_refs: [{ source_id: source.id, locator: "" }], asset_slots: assetSlots, content_status: "draft", renderers: { html: {}, pptx: {} } });
  return { project, sources: [source], outline: base("outline", "outline-main", { sections: [{ id: "main", title: "Main", page_ids: [page.id] }] }), pages: [page], theme: base("theme", "theme-default", { tokens: {} }), assets: [asset], templates: [], candidates: [], approvals: [], versions: [], builds: [], reviews: [], handoffs: [] };
}

function findRegionMappingItems(node) {
  if (!node || typeof node !== "object") return undefined;
  if (node.region_mappings?.items) return node.region_mappings.items;
  for (const value of Object.values(node)) {
    const found = findRegionMappingItems(value);
    if (found) return found;
  }
  return undefined;
}

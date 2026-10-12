import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { buildPptx } from "../src/adapters/pptx.js";
import { readProject } from "../src/core/project.js";
import { compileImageSemanticLayout } from "../src/layout/image-semantics.js";

test("confirmed mappings compile to renderer-neutral editable labels and connectors", () => {
  const asset = { image_semantics: { annotation_state: "user_confirmed", semantic_regions: [{ id: "person", role: "subject", bounds: { x: 0.25, y: 0.2, width: 0.3, height: 0.5 } }], anchor_edges: [{ id: "person-right", region_id: "person", edge: "right" }] } };
  const slot = { region_mappings: [{ content_id: "person-label", region_id: "person", anchor_id: "person-right", label: "Operator" }] };
  const result = compileImageSemanticLayout(asset, slot, { x: 1, y: 1, w: 8, h: 5 });
  assert.deepEqual(result.annotations.map(({ text, editable }) => ({ text, editable })), [{ text: "Operator", editable: true }]);
  assert.equal(result.connections[0].editable, true);
  for (const value of Object.values(result.annotations[0].geometry)) assert.ok(value >= 0);
});

test("HTML percent frames get readable labels and centered anchors keep the target uncovered", () => {
  const asset = { image_semantics: { annotation_state: "user_confirmed", semantic_regions: [{ id: "person", role: "subject", bounds: { x: 0.25, y: 0.3, width: 0.5, height: 0.5 } }], anchor_edges: [{ id: "person-center", region_id: "person", edge: "center" }] } };
  const slot = { region_mappings: [{ content_id: "person-label", region_id: "person", anchor_id: "person-center" }] };
  const percent = compileImageSemanticLayout(asset, slot, { x: 0, y: 0, w: 100, h: 100 }, { units: "percent" });
  const { geometry } = percent.annotations[0];
  assert.ok(geometry.w >= 20 && geometry.h >= 8, `label too small: ${JSON.stringify(geometry)}`);
  const { from, to } = percent.connections[0];
  assert.ok(Math.hypot(to.x - from.x, to.y - from.y) > 0);
  assert.ok(to.y < geometry.y || to.y > geometry.y + geometry.h, "label must not cover the anchor target");
  assert.throws(() => compileImageSemanticLayout(asset, slot, { x: 0, y: 0, w: 1, h: 1 }, { units: "pixels" }), /unknown image semantic layout units/);
});

test("machine observations never produce renderer annotations", () => {
  const result = compileImageSemanticLayout({ image_semantics: { annotation_state: "machine_observed", semantic_regions: [] } }, { region_mappings: [] }, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(result, { annotations: [], connections: [] });
});

test("PPTX build renders labels and connectors for every anchor edge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-image-semantics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve("examples/demo-project"), root, { recursive: true });
  await fs.writeFile(path.join(root, "assets", "scene.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect width="1000" height="500" fill="white"/></svg>');
  const edges = ["left", "right", "top", "bottom", "center"];
  const project = await readProject(root);
  project.assets = [{ id: "scene", type: "image", file: "assets/scene.svg", alt: "Scene", image_semantics: {
    annotation_state: "user_confirmed",
    semantic_regions: [{ id: "subject", role: "subject", bounds: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } }],
    anchor_edges: edges.map((edge) => ({ id: `subject-${edge}`, region_id: "subject", edge }))
  } }];
  project.pages[0].asset_slots = [{ asset_id: "scene", role: "hero", fit: "contain", region_mappings: edges.map((edge) => ({ content_id: `label-${edge}`, region_id: "subject", anchor_id: `subject-${edge}`, label: `Edge ${edge}` })) }];
  project.pages[1].asset_slots = [];
  const file = path.join(root, "semantic.pptx");
  await buildPptx(project, file);
  const xml = await (await JSZip.loadAsync(await fs.readFile(file))).file("ppt/slides/slide1.xml").async("string");
  for (const edge of edges) {
    assert.match(xml, new RegExp(`name="Semantic connector label-${edge}-connector"`));
    assert.match(xml, new RegExp(`<a:t>Edge ${edge}</a:t>`));
  }
});

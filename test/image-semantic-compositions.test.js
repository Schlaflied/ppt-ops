import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { compileImageSemanticLayout } from "../src/layout/image-semantics.js";

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/image-semantics/compositions.json", import.meta.url), "utf8"));

test("canonical image compositions retain one semantic mapping across HTML and PPTX coordinate spaces", () => {
  assert.deepEqual(fixtures.map(({ id }) => id), ["four-panel", "multiple-people", "multi-step", "single-subject-whitespace"]);
  for (const fixture of fixtures) {
    const regions = fixture.regions;
    const anchors = regions.map((region) => ({ id: `${region.id}-anchor`, region_id: region.id, edge: "center" }));
    const mappings = regions.map((region) => ({ content_id: `${region.id}-label`, region_id: region.id, anchor_id: `${region.id}-anchor`, label: region.role }));
    const asset = { image_semantics: { annotation_state: "user_confirmed", semantic_regions: regions, anchor_edges: anchors, text_safe_areas: fixture.text_safe_areas ?? [] } };
    const html = compileImageSemanticLayout(asset, { region_mappings: mappings }, { x: 0, y: 0, w: 100, h: 100 });
    const pptx = compileImageSemanticLayout(asset, { region_mappings: mappings }, { x: 1, y: 1, w: 8, h: 5 });
    assert.equal(html.annotations.length, regions.length);
    assert.deepEqual(html.annotations.map(({ id, text }) => ({ id, text })), pptx.annotations.map(({ id, text }) => ({ id, text })));
    assert.ok(pptx.annotations.every(({ editable }) => editable));
    assert.ok(pptx.connections.every(({ editable }) => editable));
  }
});

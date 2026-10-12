import assert from "node:assert/strict";
import test from "node:test";
import { compileImageSemanticLayout } from "../src/layout/image-semantics.js";

test("confirmed mappings compile to renderer-neutral editable labels and connectors", () => {
  const asset = { image_semantics: { annotation_state: "user_confirmed", semantic_regions: [{ id: "person", role: "subject", bounds: { x: 0.25, y: 0.2, width: 0.3, height: 0.5 } }], anchor_edges: [{ id: "person-right", region_id: "person", edge: "right" }] } };
  const slot = { region_mappings: [{ content_id: "person-label", region_id: "person", anchor_id: "person-right", label: "Operator" }] };
  const result = compileImageSemanticLayout(asset, slot, { x: 1, y: 1, w: 8, h: 5 });
  assert.deepEqual(result.annotations.map(({ text, editable }) => ({ text, editable })), [{ text: "Operator", editable: true }]);
  assert.equal(result.connections[0].editable, true);
  for (const value of Object.values(result.annotations[0].geometry)) assert.ok(value >= 0);
});

test("machine observations never produce renderer annotations", () => {
  const result = compileImageSemanticLayout({ image_semantics: { annotation_state: "machine_observed", semantic_regions: [] } }, { region_mappings: [] }, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(result, { annotations: [], connections: [] });
});

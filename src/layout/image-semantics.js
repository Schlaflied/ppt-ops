const LABEL_LIMITS = {
  inches: { w: 2.4, h: 0.72, gap: 0.12 },
  percent: { w: 30, h: 12, gap: 2 }
};

/** Build renderer-neutral native annotation geometry from confirmed regions. `units` is "inches" (PPTX) or "percent" (HTML). */
export function compileImageSemanticLayout(asset, slot, bounds, { units = "inches" } = {}) {
  const limits = LABEL_LIMITS[units];
  if (!limits) throw new Error(`unknown image semantic layout units: ${units}`);
  const semantics = asset.image_semantics;
  if (!semantics || semantics.annotation_state !== "user_confirmed") return { annotations: [], connections: [] };
  const regions = new Map(semantics.semantic_regions.map((region) => [region.id, region]));
  const anchors = new Map((semantics.anchor_edges ?? []).map((anchor) => [anchor.id, anchor]));
  const annotations = [];
  const connections = [];
  for (const mapping of slot.region_mappings ?? []) {
    const region = regions.get(mapping.region_id);
    if (!region) continue;
    const anchor = anchors.get(mapping.anchor_id);
    const target = anchorPoint(region.bounds, anchor?.edge ?? "center", bounds);
    const label = labelBox(target, anchor?.edge ?? "center", bounds, limits);
    annotations.push({ id: mapping.content_id, text: mapping.label ?? mapping.content_id, geometry: label, editable: true });
    connections.push({ id: `${mapping.content_id}-connector`, from: edgePoint(label, target), to: target, editable: true });
  }
  return { annotations, connections };
}

function anchorPoint(region, edge, bounds) {
  const x = edge === "left" ? region.x : edge === "right" ? region.x + region.width : region.x + region.width / 2;
  const y = edge === "top" ? region.y : edge === "bottom" ? region.y + region.height : region.y + region.height / 2;
  return { x: bounds.x + x * bounds.w, y: bounds.y + y * bounds.h };
}

function labelBox(target, edge, bounds, limits) {
  const w = Math.min(bounds.w * 0.42, limits.w), h = Math.min(bounds.h * 0.18, limits.h), gap = limits.gap;
  let x = target.x - w / 2, y = target.y - h / 2;
  // A centered anchor sits inside the region, so lift the label clear of the target (or drop it below at the top edge).
  if (edge === "center") y = target.y - h - gap >= bounds.y ? target.y - h - gap : target.y + gap;
  if (edge === "left") x = target.x - w - gap;
  if (edge === "right") x = target.x + gap;
  if (edge === "top") y = target.y - h - gap;
  if (edge === "bottom") y = target.y + gap;
  return { x: clamp(x, bounds.x, bounds.x + bounds.w - w), y: clamp(y, bounds.y, bounds.y + bounds.h - h), w, h };
}

function edgePoint(box, target) {
  return { x: clamp(target.x, box.x, box.x + box.w), y: clamp(target.y, box.y, box.y + box.h) };
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

const SLIDE_WIDTH_EMU = 12191695;
const SLIDE_HEIGHT_EMU = 6858000;

/**
 * Validate declared image semantics against Page Spec mappings and rendered
 * placements. This is contract/geometry evidence only; it does not infer what
 * pixels mean or claim human comprehension.
 */
export function analyzeImageSemantics(project, placements = []) {
  const assets = new Map((project.assets ?? []).map((asset) => [asset.id, asset]));
  const byPageAndAsset = new Map(placements.map((item) => [`${item.page}:${item.asset_id}`, item]));
  const findings = [];
  let usageCount = 0;

  for (const page of project.pages ?? []) for (const slot of page.asset_slots ?? []) {
    const asset = assets.get(slot.asset_id);
    const semantics = asset?.image_semantics;
    if (!semantics) continue;
    usageCount += 1;
    const placement = byPageAndAsset.get(`${page.page}:${asset.id}`);
    const mappings = slot.region_mappings ?? [];
    if (semantics.annotation_state !== "user_confirmed") findings.push(finding(page.page, asset.id, "image-semantics-human-confirmation", "note", {
      annotation_state: semantics.annotation_state,
      automated_claim: "Machine-observed image semantics remain pending user confirmation."
    }));
    if ((semantics.semantic_regions?.length ?? 0) > 1 && mappings.length === 0) findings.push(finding(page.page, asset.id, "image-region-mapping-missing", "warning", {
      region_ids: semantics.semantic_regions.map(({ id }) => id),
      automated_claim: "Multiple semantic regions are declared but page content is not explicitly mapped to them."
    }));
    if (!placement) {
      findings.push(finding(page.page, asset.id, "image-semantics-placement-unresolved", "warning", {
        automated_claim: "Rendered placement is unavailable; crop, occlusion and minimum display size were not verified."
      }));
      continue;
    }
    const minimum = semantics.minimum_display_size;
    if (minimum && (placement.width / SLIDE_WIDTH_EMU < minimum.width || placement.height / SLIDE_HEIGHT_EMU < minimum.height)) findings.push(finding(page.page, asset.id, "image-minimum-display-size", "warning", {
      actual: { width: round(placement.width / SLIDE_WIDTH_EMU), height: round(placement.height / SLIDE_HEIGHT_EMU) }, minimum,
      automated_claim: "Rendered image is smaller than its declared recognizability threshold; human recognition was not assessed."
    }));
    const visible = sourceVisibleRegion(placement.crop);
    for (const region of semantics.semantic_regions ?? []) if (!contains(visible, region.bounds)) findings.push(finding(page.page, asset.id, "image-semantic-region-cropped", "error", {
      region_id: region.id, visible_source_region: visible,
      automated_claim: "A declared semantic region is not fully preserved by the rendered crop."
    }));
    for (const region of semantics.forbidden_crops ?? []) if (!contains(visible, region.bounds)) findings.push(finding(page.page, asset.id, "image-forbidden-crop", "error", {
      crop_id: region.id, visible_source_region: visible,
      automated_claim: "The rendered crop removes part of a declared forbidden-crop region."
    }));
  }

  return {
    status: findings.some(({ severity }) => severity === "error") ? "failed" : findings.some(({ severity }) => severity === "warning") ? "findings" : "passed",
    scope: "declared-semantics-and-rendered-geometry",
    pixel_semantics_inferred: false,
    human_comprehension_assessed: false,
    image_semantics_usage_count: usageCount,
    findings
  };
}

function sourceVisibleRegion(crop = {}) {
  const left = clamp(crop.left ?? 0), right = clamp(crop.right ?? 0), top = clamp(crop.top ?? 0), bottom = clamp(crop.bottom ?? 0);
  return { x: left, y: top, width: Math.max(0, 1 - left - right), height: Math.max(0, 1 - top - bottom) };
}
function contains(outer, inner) { return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function round(value) { return Number(value.toFixed(4)); }
function finding(page, assetId, check, severity, evidence) { return { page, asset_id: assetId, check, severity, evidence }; }

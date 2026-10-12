const DECISIONS = new Set(["accepted", "edited", "rejected"]);

/** Normalize analyzer output into reviewable candidates without promoting it to fact. */
export function createSemanticCandidate({ asset_id, analyzer, analyzer_version, observed_at, regions = [], focal_points = [] }) {
  if (!asset_id || !analyzer || !analyzer_version || !observed_at) throw new TypeError("asset_id, analyzer, analyzer_version and observed_at are required");
  return {
    asset_id,
    annotation_state: "machine_observed",
    analyzer: { name: analyzer, version: analyzer_version },
    observed_at,
    semantic_regions: regions.map((region, index) => ({ ...region, id: region.id ?? `candidate-${index + 1}`, confidence: normalizeConfidence(region.confidence) })),
    focal_points: focal_points.map((point, index) => ({ ...point, id: point.id ?? `focus-${index + 1}`, confidence: normalizeConfidence(point.confidence) })),
    review: { status: "pending", events: [] }
  };
}

/** Record a human decision while preserving the original machine observation. */
export function reviewSemanticCandidate(candidate, { decision, reviewer, decided_at, semantic_regions, reason }) {
  if (!DECISIONS.has(decision)) throw new TypeError(`unsupported semantic review decision: ${decision}`);
  if (!reviewer || !decided_at) throw new TypeError("reviewer and decided_at are required");
  if (decision === "edited" && !Array.isArray(semantic_regions)) throw new TypeError("edited decisions require semantic_regions");
  const confirmed = decision === "rejected" ? [] : (semantic_regions ?? candidate.semantic_regions).map(({ confidence, ...region }) => region);
  return {
    ...candidate,
    annotation_state: decision === "rejected" ? "machine_observed" : "user_confirmed",
    ...(decision === "rejected" ? {} : { semantic_regions: confirmed }),
    review: {
      status: decision,
      events: [...(candidate.review?.events ?? []), { decision, reviewer, decided_at, ...(reason ? { reason } : {}) }]
    }
  };
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

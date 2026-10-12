/**
 * Online-lecture delivery contract: screen-share safe zones, 720p legibility
 * thresholds and interaction cadence. Geometry is normalized to the 16:9 slide
 * (0,0 = top-left, 1,1 = bottom-right) so the same zones apply to PPTX EMU,
 * rendered HTML pixels and downscaled screenshots.
 */

export const ONLINE_LECTURE_MODE = "online_lecture";
export const REFERENCE_HEIGHT_PX = 1080;
export const EVALUATION_HEIGHT_PX = 720;
export const DEFAULT_INTERACTION_INTERVAL_MINUTES = 8;

/**
 * Legibility thresholds. Font and stroke sizes are expressed at the 1920×1080
 * reference size; checks report the equivalent size after a 1080p → 720p
 * downscale (×2/3), which approximates compressed screen sharing and replay.
 */
export const ONLINE_LECTURE_LEGIBILITY = Object.freeze({
  reference_height_px: REFERENCE_HEIGHT_PX,
  evaluation_height_px: EVALUATION_HEIGHT_PX,
  minimum_body_font_px: 32,
  minimum_secondary_font_px: 20,
  minimum_stroke_px: 3,
  minimum_contrast_ratio: 4.5
});

/** live_talk projection baseline, for comparison in docs and tests. */
export const LIVE_TALK_MINIMUM_BODY_FONT_PX = 24;

const zone = (name, x, y, width, height, description) => Object.freeze({ name, x, y, width, height, description });

/**
 * Approximate default occlusions while sharing a 16:9 slide full-screen. These
 * are conservative planning defaults, not measurements of any client version;
 * window layouts vary by platform, client version and participant settings.
 */
export const SAFE_ZONE_PRESETS = Object.freeze({
  tencent_meeting: Object.freeze({
    label: "Tencent Meeting (腾讯会议)",
    zones: Object.freeze([
      zone("tencent_meeting.share_toolbar", 0.2, 0, 0.6, 0.08, "Top-centre floating sharing toolbar."),
      zone("tencent_meeting.self_view", 0.78, 0.72, 0.22, 0.28, "Self-view / speaker camera tile, bottom-right.")
    ])
  }),
  zoom: Object.freeze({
    label: "Zoom",
    zones: Object.freeze([
      zone("zoom.share_banner", 0.25, 0, 0.5, 0.07, "Top-centre \"You are screen sharing\" banner and controls."),
      zone("zoom.video_panel", 0.8, 0.07, 0.2, 0.25, "Floating participant video panel, top-right.")
    ])
  }),
  feishu: Object.freeze({
    label: "Feishu / Lark Meetings (飞书会议)",
    zones: Object.freeze([
      zone("feishu.share_toolbar", 0.25, 0, 0.5, 0.07, "Top-centre floating sharing toolbar."),
      zone("feishu.camera_tile", 0.8, 0.74, 0.2, 0.26, "Speaker camera tile, bottom-right.")
    ])
  }),
  replay_captions: Object.freeze({
    label: "Recorded replay with burned-in captions",
    zones: Object.freeze([
      zone("replay_captions.caption_band", 0, 0.88, 1, 0.12, "Bottom caption band on recorded replays and live captions.")
    ])
  })
});

export const SAFE_ZONE_PRESET_NAMES = Object.freeze(Object.keys(SAFE_ZONE_PRESETS));

const ZONE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateOnlineLectureProjectFields(project) {
  const errors = [];
  if (project?.safe_zones !== undefined) {
    if (!Array.isArray(project.safe_zones)) errors.push("safe_zones must be an array");
    else {
      const names = new Set();
      for (const [index, item] of project.safe_zones.entries()) {
        const prefix = `safe_zones[${index}]`;
        if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${prefix} must be an object`); continue; }
        if (item.preset !== undefined) {
          if (Object.keys(item).some((key) => key !== "preset")) errors.push(`${prefix} must declare either preset or a rectangle`);
          if (!SAFE_ZONE_PRESET_NAMES.includes(item.preset)) errors.push(`${prefix}.preset is invalid: ${item.preset}`);
          continue;
        }
        if (typeof item.name !== "string" || !ZONE_NAME.test(item.name)) errors.push(`${prefix}.name must be a stable lowercase identifier`);
        else if (names.has(item.name)) errors.push(`${prefix}.name is duplicated: ${item.name}`);
        else names.add(item.name);
        if (!isNormalizedRect(item)) errors.push(`${prefix} must be a normalized rectangle inside 0..1`);
        if (item.description !== undefined && (typeof item.description !== "string" || item.description.trim() === "")) errors.push(`${prefix}.description must be a non-empty string`);
        for (const key of Object.keys(item)) if (!["name", "x", "y", "width", "height", "description"].includes(key)) errors.push(`${prefix}.${key} is not allowed`);
      }
    }
  }
  const interval = project?.interaction_interval_minutes;
  if (interval !== undefined && !(typeof interval === "number" && Number.isFinite(interval) && interval > 0 && interval <= 60)) {
    errors.push("interaction_interval_minutes must be a number between 0 and 60");
  }
  return errors;
}

/** Project fields can live on the Foundation manifest or the V1 project contract. */
export function onlineLectureSettings(project) {
  const manifest = project?.project ?? {};
  const contract = project?.contracts?.project ?? {};
  const safeZones = manifest.safe_zones ?? contract.safe_zones;
  const interval = manifest.interaction_interval_minutes ?? contract.interaction_interval_minutes;
  return {
    delivery_mode: manifest.delivery_mode ?? contract.delivery_mode ?? null,
    safe_zones_declared: Array.isArray(safeZones),
    safe_zones: resolveSafeZones(safeZones),
    interaction_interval_minutes: interval ?? DEFAULT_INTERACTION_INTERVAL_MINUTES,
    legibility: ONLINE_LECTURE_LEGIBILITY
  };
}

export function resolveSafeZones(safeZones = []) {
  if (!Array.isArray(safeZones)) return [];
  return safeZones.flatMap((item) => item?.preset !== undefined
    ? (SAFE_ZONE_PRESETS[item.preset]?.zones ?? []).map((preset) => ({ ...preset, preset: item.preset }))
    : isNormalizedRect(item) ? [{ name: item.name, x: item.x, y: item.y, width: item.width, height: item.height, ...(item.description ? { description: item.description } : {}) }] : []);
}

/**
 * Walk the deck by estimated_duration_seconds and report every stretch longer
 * than the interval without a PageSpec that declares audience_interaction.
 * Estimates are planning data, not rehearsed timing.
 */
export function inspectInteractionCadence(pages = [], { intervalMinutes = DEFAULT_INTERACTION_INTERVAL_MINUTES } = {}) {
  const intervalSeconds = Math.round(intervalMinutes * 60);
  const findings = [];
  const unestimated = pages.filter((page) => !(Number.isInteger(page.estimated_duration_seconds) && page.estimated_duration_seconds > 0)).map((page) => page.page);
  let gap = 0;
  let gapStart = pages[0]?.page ?? null;
  let open = null;
  for (const page of pages) {
    if (page.audience_interaction) { gap = 0; gapStart = page.page; open = null; continue; }
    gap += page.estimated_duration_seconds ?? 0;
    if (open) {
      // Extend the current over-long gap instead of reporting every later page.
      open.evidence.gap_end_page = page.page;
      open.evidence.gap_seconds = gap;
    } else if (gap > intervalSeconds) {
      open = {
        page: page.page,
        check: "online-lecture-interaction-cadence",
        severity: "warning",
        evidence: { gap_start_page: gapStart, gap_end_page: page.page, gap_seconds: gap, interval_seconds: intervalSeconds, basis: "estimated_duration_seconds (planning estimate, not rehearsed timing)" }
      };
      findings.push(open);
    }
  }
  if (unestimated.length > 0) {
    findings.push({
      page: null,
      check: "online-lecture-duration-unestimated",
      severity: "note",
      evidence: { pages: unestimated, reason: "Pages without estimated_duration_seconds count as zero seconds in the interaction cadence." }
    });
  }
  return { interval_seconds: intervalSeconds, total_estimated_seconds: pages.reduce((sum, page) => sum + (page.estimated_duration_seconds ?? 0), 0), findings };
}

export function intersectNormalized(rect, zoneRect) {
  const x = Math.max(rect.x, zoneRect.x);
  const y = Math.max(rect.y, zoneRect.y);
  const width = Math.min(rect.x + rect.width, zoneRect.x + zoneRect.width) - x;
  const height = Math.min(rect.y + rect.height, zoneRect.y + zoneRect.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function isNormalizedRect(rect) {
  if (!rect || typeof rect !== "object") return false;
  const { x, y, width, height } = rect;
  return [x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))
    && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9;
}

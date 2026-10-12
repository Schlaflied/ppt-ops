import { contrastRatio } from "../accessibility/index.js";
import { EVALUATION_HEIGHT_PX, ONLINE_LECTURE_LEGIBILITY, REFERENCE_HEIGHT_PX, intersectNormalized } from "../contracts/online-lecture.js";

const SLIDE_WIDTH_EMU = 12191695;
const SLIDE_HEIGHT_EMU = 6858000;
const EMU_PER_PX_1080 = SLIDE_HEIGHT_EMU / REFERENCE_HEIGHT_PX;
const DOWNSCALE = EVALUATION_HEIGHT_PX / REFERENCE_HEIGHT_PX;
const MINIMUM_OCCLUSION_RATIO = 0.02;
const NON_KEY_NAME = /^(?:Decorative|Background|Theme accent|Footer rule|Boundary title support)|^Slide \d+ number$/i;
const SECONDARY_NAME = /^(?:Slide \d+ number|Slide \d+ citations|Screenshot caption|Diagram connector label)/i;

/**
 * Online-lecture geometry and legibility review over normalized page elements.
 *
 * Element contract: { id, rect: {x,y,width,height} in 0..1 of the slide,
 * key: boolean, text?: { font_px, secondary, foreground, background } } and
 * strokes: [{ id, stroke_px }]. Sizes are px at the 1080p reference height;
 * every legibility comparison is made after scaling to the 720p view.
 * This is deterministic arithmetic, not pixel or OCR analysis.
 */
export function analyzeOnlineLecture(pages, { safeZones = [], legibility = ONLINE_LECTURE_LEGIBILITY } = {}) {
  const findings = [];
  const minimumBody720 = round(legibility.minimum_body_font_px * DOWNSCALE);
  const minimumSecondary720 = round(legibility.minimum_secondary_font_px * DOWNSCALE);
  const minimumStroke720 = round(legibility.minimum_stroke_px * DOWNSCALE);
  for (const page of pages) {
    const seen = new Set();
    for (const element of page.elements ?? []) {
      if (element.key && !seen.has(element.id)) {
        seen.add(element.id);
        for (const zone of safeZones) {
          const overlap = intersectNormalized(element.rect, zone);
          const ratio = overlap ? overlap.width * overlap.height / (element.rect.width * element.rect.height) : 0;
          if (ratio <= MINIMUM_OCCLUSION_RATIO) continue;
          findings.push(finding(page.page, "online-safe-zone-occlusion", "warning", {
            element: element.id, zone: zone.name, ...(zone.preset ? { preset: zone.preset } : {}),
            overlap_ratio: round(ratio, 4), element_rect: roundRect(element.rect), zone_rect: roundRect(zone),
            reason: "Key text, data or legend is likely hidden by the meeting app while screen sharing."
          }));
        }
      }
      const text = element.text;
      if (!text || !Number.isFinite(text.font_px)) continue;
      const fontPx720 = round(text.font_px * DOWNSCALE);
      const minimum720 = text.secondary ? minimumSecondary720 : minimumBody720;
      if (fontPx720 < minimum720) {
        findings.push(finding(page.page, "online-720p-font-size", "warning", {
          element: element.id, text_role: text.secondary ? "secondary" : "body",
          font_px_1080: round(text.font_px), font_px_720: fontPx720, minimum_px_720: minimum720,
          minimum_px_1080: text.secondary ? legibility.minimum_secondary_font_px : legibility.minimum_body_font_px
        }));
      }
      if (text.foreground && text.background) {
        const ratio = contrastRatio(text.foreground, text.background);
        if (ratio === null) continue;
        if (ratio < legibility.minimum_contrast_ratio) {
          findings.push(finding(page.page, "online-720p-contrast", "warning", {
            element: element.id, foreground: text.foreground, background: text.background,
            contrast_ratio: round(ratio), minimum_contrast_ratio: legibility.minimum_contrast_ratio, font_px_720: fontPx720,
            reason: "Compressed screen sharing blurs low-contrast text; the large-text exemption is not applied at 720p."
          }));
        }
      }
    }
    for (const stroke of page.strokes ?? []) {
      const stroke720 = round(stroke.stroke_px * DOWNSCALE);
      if (stroke720 < minimumStroke720) {
        findings.push(finding(page.page, "online-720p-thin-line", "warning", {
          element: stroke.id, stroke_px_1080: round(stroke.stroke_px), stroke_px_720: stroke720, minimum_px_720: minimumStroke720
        }));
      }
    }
  }
  return {
    status: findings.length === 0 ? "passed" : "findings",
    scope: "declared-geometry-arithmetic",
    view: { reference_height_px: REFERENCE_HEIGHT_PX, evaluation_height_px: EVALUATION_HEIGHT_PX, scale: round(DOWNSCALE, 4) },
    thresholds: { ...legibility, minimum_body_font_px_720: minimumBody720, minimum_secondary_font_px_720: minimumSecondary720, minimum_stroke_px_720: minimumStroke720 },
    safe_zones: safeZones,
    human_readability_assessed: false,
    findings
  };
}

/** Extract normalized online-lecture elements from one generated PPTX slide. */
export function extractPptxOnlineElements(xml, page) {
  const slideBackground = normalizeHex(xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]) ?? "#FFFFFF";
  const elements = [];
  const strokes = [];
  let index = 0;
  for (const match of xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)\b[\s\S]*?<\/p:\1>/g)) {
    index += 1;
    const [block, tag] = match;
    const geometry = block.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!geometry) continue;
    const name = block.match(/<p:cNvPr[^>]+\bname="([^"]*)"/)?.[1] ?? "";
    const id = name || `shape-${index}`;
    const decorative = NON_KEY_NAME.test(name) || /descr="decorative"/i.test(block);
    const rect = {
      x: Number(geometry[1]) / SLIDE_WIDTH_EMU, y: Number(geometry[2]) / SLIDE_HEIGHT_EMU,
      width: Number(geometry[3]) / SLIDE_WIDTH_EMU, height: Number(geometry[4]) / SLIDE_HEIGHT_EMU
    };
    const isLine = tag === "cxnSp" || /<a:prstGeom prst="(?:line|straightConnector1)"/.test(block);
    if (isLine) {
      const line = block.match(/<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/);
      const width = Number(line?.[1].match(/\bw="(\d+)"/)?.[1] ?? 12700);
      const visible = line && !/<a:noFill\/>/.test(line[2]) && !/<a:alpha val="0"\/>/.test(line[2]);
      if (visible && !decorative) strokes.push({ id, stroke_px: width / EMU_PER_PX_1080 });
      continue;
    }
    const hasText = /<a:t>[^<]*\S[^<]*<\/a:t>/.test(block);
    const hasMedia = tag === "pic" || tag === "graphicFrame";
    if (!hasText && !hasMedia) continue;
    const element = { id, rect, key: !decorative && (hasText || hasMedia) };
    if (hasText && !decorative) {
      const fill = block.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0].match(/^(?:(?!<a:ln)[\s\S])*?<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"(?:\s*\/>|>\s*<a:alpha val="(\d+)"\/>)/);
      const background = fill ? blend(normalizeHex(fill[1]), slideBackground, alpha(fill[2])) : slideBackground;
      const runs = [...block.matchAll(/<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)\s*<a:t>([^<]*)<\/a:t>/g)].filter((run) => run[3].trim());
      const sizes = runs.map((run) => Number(run[1].match(/\bsz="(\d+)"/)?.[1])).filter((value) => value > 0);
      const smallest = sizes.length ? Math.min(...sizes) / 100 : undefined;
      const colorRun = runs.find((run) => /<a:srgbClr/.test(run[2] ?? ""));
      const color = colorRun?.[2].match(/<a:srgbClr val="([0-9A-Fa-f]{6})"(?:\s*\/>|>\s*<a:alpha val="(\d+)"\/>)/);
      element.text = {
        // PowerPoint points map to 2 px at the 1920×1080 reference size.
        font_px: smallest === undefined ? undefined : smallest * 2,
        secondary: SECONDARY_NAME.test(name),
        foreground: color ? blend(normalizeHex(color[1]), background, alpha(color[2])) : undefined,
        background
      };
    }
    elements.push(element);
  }
  return { page, elements, strokes };
}

function alpha(value) { return value === undefined ? 1 : Number(value) / 100000; }
function normalizeHex(value) { return value ? `#${value.toUpperCase()}` : undefined; }
function blend(foreground, background, opacity) {
  if (opacity >= 1) return foreground;
  const parse = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const [f, b] = [parse(foreground), parse(background)];
  return `#${f.map((value, i) => Math.round(value * opacity + b[i] * (1 - opacity)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
function finding(page, check, severity, evidence) { return { page, check, severity, evidence }; }
function round(value, digits = 2) { return Number(value.toFixed(digits)); }
function roundRect(rect) { return { x: round(rect.x, 4), y: round(rect.y, 4), width: round(rect.width, 4), height: round(rect.height, 4) }; }

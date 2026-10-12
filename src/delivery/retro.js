/**
 * Delivery retro (#127): validate a delivery record exported from the HTML presenter
 * view, turn it into a Markdown retro report, append per-page `delivery_feedback`
 * to the matching PageSpecs, and surface pages that keep getting marked.
 *
 * Timing on a record is the presenter talk clock: paused time is excluded and
 * blackout time counts towards the page on screen.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DELIVERY_MARK_KINDS, DELIVERY_VENUES, validateDeliveryFeedback } from "../contracts/delivery.js";
import { resolveProjectPath } from "../core/project.js";

export const DELIVERY_RECORD_KIND = "delivery_record";
export const DELIVERY_RECORD_VERSION = "1.0";
export const DELIVERY_TIMING_BASIS = "talk_clock_excluding_pauses";
export const DELIVERIES_DIR = "deliveries";
/** A page is overtime when it ran more than 20% and at least 10 seconds over its estimate. */
export const OVERTIME_RATIO = 1.2;
export const OVERTIME_MIN_SECONDS = 10;
/** Pages shown for less than this (and not explicitly marked) count as flicked past, i.e. skipped. */
export const SKIP_DWELL_SECONDS = 5;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MARK_LABELS = { stumble: "讲不顺（!）", question: "观众有疑问（?）", skipped: "跳过（X）", overtime: "超时" };
const MARK_SUGGESTIONS = {
  stumble: "调整论证顺序或补一句过渡，重写本页讲稿后再试讲一次",
  question: "在页面或讲稿中补充定义、例子或答疑，预判观众的问题",
  skipped: "考虑删除、合并或移入附录，或确认这一页是否真的需要讲",
  overtime: "拆页或删减内容，或把时长预算调高到实测水平"
};

/** Validate an exported delivery record. Returns a list of error strings (empty when valid). */
export function validateDeliveryRecord(record) {
  const errors = [];
  if (!isObject(record)) return ["delivery record must be a JSON object"];
  allowKeys(record, ["kind", "schema_version", "generator", "deck", "delivery", "pages", "marks"], "record", errors);
  if (record.kind !== DELIVERY_RECORD_KIND) errors.push(`kind must be ${DELIVERY_RECORD_KIND}`);
  if (record.schema_version !== DELIVERY_RECORD_VERSION) errors.push(`schema_version must be ${DELIVERY_RECORD_VERSION}`);
  if (record.generator !== undefined && !hasText(record.generator)) errors.push("generator must be a non-empty string");
  const deck = record.deck;
  if (!isObject(deck)) errors.push("deck must be an object");
  else {
    allowKeys(deck, ["id", "project", "title", "page_count"], "deck", errors);
    if (!hasText(deck.id)) errors.push("deck.id is required");
    if (deck.project !== null && !hasText(deck.project)) errors.push("deck.project must be a project name or null");
    if (!hasText(deck.title)) errors.push("deck.title is required");
    if (!Number.isInteger(deck.page_count) || deck.page_count < 1) errors.push("deck.page_count must be a positive integer");
  }
  const delivery = record.delivery;
  if (!isObject(delivery)) errors.push("delivery must be an object");
  else {
    allowKeys(delivery, ["date", "venue", "label", "started_at", "exported_at", "timing_basis", "total_seconds"], "delivery", errors);
    if (typeof delivery.date !== "string" || !DATE_PATTERN.test(delivery.date) || Number.isNaN(Date.parse(`${delivery.date}T00:00:00Z`))) errors.push("delivery.date must be YYYY-MM-DD");
    if (!DELIVERY_VENUES.includes(delivery.venue)) errors.push(`delivery.venue must be one of ${DELIVERY_VENUES.join(", ")}`);
    if (delivery.label !== undefined && (typeof delivery.label !== "string" || delivery.label.length > 120)) errors.push("delivery.label must be a string of at most 120 characters");
    for (const field of ["started_at", "exported_at"]) if (!isIso(delivery[field])) errors.push(`delivery.${field} must be an ISO 8601 timestamp`);
    if (delivery.timing_basis !== DELIVERY_TIMING_BASIS) errors.push(`delivery.timing_basis must be ${DELIVERY_TIMING_BASIS}`);
    if (!isSeconds(delivery.total_seconds)) errors.push("delivery.total_seconds must be a non-negative number");
  }
  const pageNumbers = new Set();
  if (!Array.isArray(record.pages) || record.pages.length === 0) errors.push("pages must be a non-empty array");
  else {
    if (isObject(deck) && Number.isInteger(deck.page_count) && record.pages.length !== deck.page_count) errors.push("pages must list every deck page (deck.page_count)");
    record.pages.forEach((page, index) => {
      const field = `pages[${index}]`;
      if (!isObject(page)) { errors.push(`${field} must be an object`); return; }
      allowKeys(page, ["page", "id", "title", "estimated_seconds", "actual_seconds", "visits"], field, errors);
      if (!Number.isInteger(page.page) || page.page < 1) errors.push(`${field}.page must be a positive integer`);
      else if (pageNumbers.has(page.page)) errors.push(`${field}.page is duplicated: ${page.page}`);
      else pageNumbers.add(page.page);
      if (page.id !== undefined && (typeof page.id !== "string" || !ID_PATTERN.test(page.id))) errors.push(`${field}.id must be a stable lowercase identifier`);
      if (!hasText(page.title)) errors.push(`${field}.title is required`);
      if (page.estimated_seconds !== undefined && (!Number.isInteger(page.estimated_seconds) || page.estimated_seconds < 1)) errors.push(`${field}.estimated_seconds must be a positive integer`);
      if (!isSeconds(page.actual_seconds)) errors.push(`${field}.actual_seconds must be a non-negative number`);
      if (!Array.isArray(page.visits)) { errors.push(`${field}.visits must be an array`); return; }
      let sum = 0;
      page.visits.forEach((visit, position) => {
        const visitField = `${field}.visits[${position}]`;
        if (!isObject(visit)) { errors.push(`${visitField} must be an object`); return; }
        allowKeys(visit, ["enter_seconds", "leave_seconds", "entered_at", "left_at"], visitField, errors);
        if (!isSeconds(visit.enter_seconds) || !isSeconds(visit.leave_seconds) || visit.leave_seconds < visit.enter_seconds) errors.push(`${visitField} needs 0 <= enter_seconds <= leave_seconds`);
        else sum += visit.leave_seconds - visit.enter_seconds;
        for (const stamp of ["entered_at", "left_at"]) if (!isIso(visit[stamp])) errors.push(`${visitField}.${stamp} must be an ISO 8601 timestamp`);
      });
      if (isSeconds(page.actual_seconds) && Math.abs(sum - page.actual_seconds) > 0.2 + 0.05 * page.visits.length) errors.push(`${field}.actual_seconds must equal the sum of its visits`);
    });
  }
  if (!Array.isArray(record.marks)) errors.push("marks must be an array");
  else record.marks.forEach((mark, index) => {
    const field = `marks[${index}]`;
    if (!isObject(mark)) { errors.push(`${field} must be an object`); return; }
    allowKeys(mark, ["page", "kind", "at_seconds", "marked_at"], field, errors);
    if (!Number.isInteger(mark.page) || (pageNumbers.size && !pageNumbers.has(mark.page))) errors.push(`${field}.page must reference a page in pages[]`);
    if (!DELIVERY_MARK_KINDS.includes(mark.kind)) errors.push(`${field}.kind must be one of ${DELIVERY_MARK_KINDS.join(", ")}`);
    if (!isSeconds(mark.at_seconds)) errors.push(`${field}.at_seconds must be a non-negative number`);
    if (!isIso(mark.marked_at)) errors.push(`${field}.marked_at must be an ISO 8601 timestamp`);
  });
  return errors;
}

/** Stable id for one delivery: date, venue and a content hash, so re-importing is detected. */
export function deliveryIdFor(record) {
  const hash = crypto.createHash("sha256").update(stableJson(record)).digest("hex").slice(0, 8);
  return `${record.delivery.date}-${record.delivery.venue}-${hash}`;
}

/**
 * Compare a validated record against the project's PageSpecs. Pages match by PageSpec id
 * when the record carries one, otherwise by page number. The project's current estimate
 * wins over the estimate captured in the record.
 */
export function analyzeDeliveryRecord(project, record, { deliveryId = deliveryIdFor(record) } = {}) {
  const warnings = [];
  const projectName = project.project.name;
  if (record.deck.project && record.deck.project !== projectName) {
    const error = new Error(`delivery record belongs to project ${record.deck.project}, not ${projectName}`);
    error.code = "DELIVERY_RECORD_PROJECT_MISMATCH";
    throw error;
  }
  if (!record.deck.project) warnings.push("record does not name its project; pages were matched by id/page number only");
  if (record.deck.page_count !== project.pages.length) warnings.push(`deck had ${record.deck.page_count} pages when delivered; project now has ${project.pages.length}`);
  const byId = new Map(project.pages.filter((page) => page.id).map((page) => [page.id, page]));
  const byNumber = new Map(project.pages.map((page) => [page.page, page]));
  const marksByPage = new Map();
  for (const mark of record.marks) {
    const list = marksByPage.get(mark.page) ?? [];
    list.push(mark);
    marksByPage.set(mark.page, list);
  }
  const rows = [];
  for (const entry of record.pages) {
    const page = (entry.id && byId.get(entry.id)) || (!entry.id || !byId.size ? byNumber.get(entry.page) : undefined);
    if (!page) { warnings.push(`delivered page ${entry.page}${entry.id ? ` (${entry.id})` : ""} no longer exists in the project`); continue; }
    if (page.screen_text?.title !== entry.title) warnings.push(`page ${page.page} title changed since delivery: “${entry.title}” → “${page.screen_text?.title}”`);
    const estimated = page.estimated_duration_seconds ?? entry.estimated_seconds;
    const marks = marksByPage.get(entry.page) ?? [];
    const markKinds = DELIVERY_MARK_KINDS.filter((kind) => marks.some((mark) => mark.kind === kind));
    const actual = round1(entry.actual_seconds);
    const explicitSkip = markKinds.includes("skipped");
    const skippedReason = explicitSkip ? "marked" : entry.visits.length === 0 ? "not_shown" : actual < SKIP_DWELL_SECONDS ? "flicked_past" : null;
    const overtime = Boolean(estimated) && !skippedReason && actual > estimated * OVERTIME_RATIO && actual - estimated >= OVERTIME_MIN_SECONDS;
    rows.push({
      page: page.page, ...(page.id ? { id: page.id } : {}), title: page.screen_text?.title ?? entry.title,
      ...(estimated ? { estimated_seconds: estimated } : {}), actual_seconds: actual,
      ...(estimated ? { delta_seconds: round1(actual - estimated) } : {}),
      visit_count: entry.visits.length, marks: markKinds, mark_times: marks.map((mark) => ({ kind: mark.kind, at_seconds: mark.at_seconds })),
      skipped: Boolean(skippedReason), skipped_reason: skippedReason, overtime
    });
  }
  const estimatedRows = rows.filter((row) => row.estimated_seconds);
  return {
    delivery_id: deliveryId,
    project: projectName,
    title: project.project.title,
    date: record.delivery.date,
    venue: record.delivery.venue,
    ...(record.delivery.label ? { label: record.delivery.label } : {}),
    started_at: record.delivery.started_at,
    total_seconds: round1(record.delivery.total_seconds),
    estimated_total_seconds: estimatedRows.reduce((sum, row) => sum + row.estimated_seconds, 0),
    estimated_page_count: estimatedRows.length,
    rows,
    skipped_pages: rows.filter((row) => row.skipped).map((row) => row.page),
    overtime_pages: rows.filter((row) => row.overtime).map((row) => row.page),
    mark_counts: Object.fromEntries(DELIVERY_MARK_KINDS.map((kind) => [kind, record.marks.filter((mark) => mark.kind === kind).length])),
    warnings
  };
}

/** One `delivery_feedback` entry for a page row. */
export function feedbackEntry(analysis, row, reportPath) {
  return {
    delivery_id: analysis.delivery_id, date: analysis.date, venue: analysis.venue,
    actual_seconds: row.actual_seconds, ...(row.estimated_seconds ? { estimated_seconds: row.estimated_seconds } : {}),
    visit_count: row.visit_count, skipped: row.skipped, overtime: row.overtime, marks: row.marks,
    ...(reportPath ? { report: reportPath } : {})
  };
}

/**
 * Import a delivery record file into a project: writes `deliveries/<id>.json` and
 * `deliveries/<id>.md`, and appends `delivery_feedback` to the matching PageSpecs in
 * pages.json. Refuses records that do not validate or were already imported.
 */
export async function importDeliveryRecord(project, recordFile) {
  let record;
  try { record = JSON.parse(await fs.readFile(path.resolve(recordFile), "utf8")); }
  catch (cause) { const error = new Error(`delivery record is not readable JSON: ${cause.message}`); error.code = "DELIVERY_RECORD_INVALID"; throw error; }
  const errors = validateDeliveryRecord(record);
  if (errors.length) { const error = new Error(`delivery record is invalid:\n${errors.map((item) => `- ${item}`).join("\n")}`); error.code = "DELIVERY_RECORD_INVALID"; error.details = { errors }; throw error; }
  const analysis = analyzeDeliveryRecord(project, record);
  if (project.pages.some((page) => page.delivery_feedback?.some((entry) => entry.delivery_id === analysis.delivery_id))) {
    const error = new Error(`delivery ${analysis.delivery_id} was already imported`);
    error.code = "DELIVERY_ALREADY_IMPORTED";
    throw error;
  }
  const recordPath = `${DELIVERIES_DIR}/${analysis.delivery_id}.json`;
  const reportPath = `${DELIVERIES_DIR}/${analysis.delivery_id}.md`;
  // Raw pages.json is updated (not the materialized view) so corporate-profile defaults never leak into source.
  const rawPages = JSON.parse(await fs.readFile(project.pagesFile, "utf8"));
  const rowFor = (raw) => analysis.rows.find((row) => (row.id && raw.id ? row.id === raw.id : row.page === raw.page));
  let updated = 0;
  const nextPages = rawPages.map((raw) => {
    const row = rowFor(raw);
    if (!row) return raw;
    updated += 1;
    return { ...raw, delivery_feedback: [...(raw.delivery_feedback ?? []), feedbackEntry(analysis, row, reportPath)] };
  });
  for (const page of nextPages) {
    const feedbackErrors = validateDeliveryFeedback(page.delivery_feedback);
    if (feedbackErrors.length) { const error = new Error(`page ${page.page} delivery_feedback is invalid: ${feedbackErrors.join("; ")}`); error.code = "DELIVERY_FEEDBACK_INVALID"; throw error; }
  }
  const history = nextPages.map((raw) => ({ page: raw.page, ...(raw.id ? { id: raw.id } : {}), title: project.pages.find((page) => (raw.id ? page.id === raw.id : page.page === raw.page))?.screen_text?.title ?? raw.screen_text?.title, delivery_feedback: raw.delivery_feedback ?? [] }));
  const repeated = repeatedDeliveryMarks(history);
  const markdown = renderDeliveryRetroMarkdown(analysis, { recordPath, repeated });
  const recordTarget = resolveProjectPath(project.root, recordPath);
  const reportTarget = resolveProjectPath(project.root, reportPath);
  await fs.mkdir(path.dirname(recordTarget), { recursive: true });
  await fs.writeFile(recordTarget, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  await fs.writeFile(reportTarget, markdown, { flag: "wx" });
  await atomicWriteJson(project.pagesFile, nextPages);
  return {
    delivery_id: analysis.delivery_id, record_file: recordTarget, report_file: reportTarget, pages_updated: updated,
    total_seconds: analysis.total_seconds, estimated_total_seconds: analysis.estimated_total_seconds,
    skipped_pages: analysis.skipped_pages, overtime_pages: analysis.overtime_pages, mark_counts: analysis.mark_counts,
    repeated_marks: repeated.pages, warnings: analysis.warnings
  };
}

/**
 * Latest measured talk time for a page, or null. Skipped and not-shown deliveries are
 * ignored. This is the hook the #124 talk-budget check uses to prefer rehearsed timing.
 */
export function latestRehearsedDuration(page) {
  const entries = orderedFeedback(page?.delivery_feedback).filter((entry) => !entry.skipped && entry.actual_seconds > 0);
  const latest = entries.at(-1);
  return latest ? { seconds: Math.round(latest.actual_seconds), date: latest.date, delivery_id: latest.delivery_id } : null;
}

/**
 * Per-page duration with provenance: the latest rehearsed time when one exists, otherwise
 * the planning estimate, otherwise null. `source` is `rehearsed` or `estimated`.
 */
export function resolvePageDuration(page) {
  const rehearsed = latestRehearsedDuration(page);
  if (rehearsed) return { seconds: rehearsed.seconds, source: "rehearsed", date: rehearsed.date, delivery_id: rehearsed.delivery_id, ...(page.estimated_duration_seconds ? { estimated_seconds: page.estimated_duration_seconds } : {}) };
  if (Number.isInteger(page?.estimated_duration_seconds) && page.estimated_duration_seconds > 0) return { seconds: page.estimated_duration_seconds, source: "estimated" };
  return null;
}

/** Every page's resolved duration, in page order (see `resolvePageDuration`). */
export function rehearsedDurations(pages) {
  return (pages ?? []).map((page) => ({ page: page.page, ...(page.id ? { id: page.id } : {}), duration: resolvePageDuration(page) }));
}

/**
 * Pages flagged in both of the project's two most recent deliveries (a mark, a skip or
 * overtime each time). Returns `{ deliveries: [older, newer], pages: [...] }`.
 */
export function repeatedDeliveryMarks(pages) {
  const order = new Map();
  for (const page of pages ?? []) for (const entry of page.delivery_feedback ?? []) {
    const known = order.get(entry.delivery_id);
    if (!known) order.set(entry.delivery_id, { date: entry.date, first: order.size });
  }
  const deliveries = [...order.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date) || a[1].first - b[1].first).map(([id]) => id);
  if (deliveries.length < 2) return { deliveries, pages: [] };
  const lastTwo = deliveries.slice(-2);
  const flagged = [];
  for (const page of pages) {
    const entries = lastTwo.map((id) => page.delivery_feedback?.find((entry) => entry.delivery_id === id));
    if (entries.some((entry) => !entry)) continue;
    const signals = entries.map(signalsOf);
    if (signals.some((list) => list.length === 0)) continue;
    const kinds = [...new Set(signals.flat())];
    flagged.push({
      page: page.page, ...(page.id ? { id: page.id } : {}), ...(page.title ?? page.screen_text?.title ? { title: page.title ?? page.screen_text?.title } : {}),
      deliveries: lastTwo.map((id, index) => ({ delivery_id: id, date: entries[index].date, signals: signals[index] })),
      suggestions: kinds.map((kind) => `${MARK_LABELS[kind]}：${MARK_SUGGESTIONS[kind]}`)
    });
  }
  return { deliveries: lastTwo, pages: flagged };
}

/** Advisory review check: never blocks, appears only once a project has delivery feedback. */
export function inspectDeliveryFeedback(project) {
  const pages = project.pages ?? [];
  if (!pages.some((page) => page.delivery_feedback?.length)) return null;
  const repeated = repeatedDeliveryMarks(pages);
  return {
    id: "delivery-feedback",
    kind: "automated",
    required: false,
    status: repeated.pages.length ? "pending" : "passed",
    evidence: {
      deliveries_compared: repeated.deliveries,
      repeated_pages: repeated.pages,
      summary: repeated.pages.length
        ? `${repeated.pages.length} page(s) were marked in both of the last two deliveries; revise them before the next delivery.`
        : repeated.deliveries.length < 2 ? "Only one delivery recorded; repeated-mark hints need two." : "No page was marked in both of the last two deliveries."
    }
  };
}

/** Markdown retro report (Chinese, matching the project documents). */
export function renderDeliveryRetroMarkdown(analysis, { recordPath, repeated = { pages: [] } } = {}) {
  const venue = analysis.venue === "online" ? "线上" : "线下";
  const lines = [`# 演讲复盘：${analysis.title}`, ""];
  lines.push(`- 场次：${analysis.date} · ${venue}${analysis.label ? ` · ${analysis.label}` : ""}（\`${analysis.delivery_id}\`）`);
  if (recordPath) lines.push(`- 原始记录：\`${recordPath}\``);
  lines.push("- 计时口径：演讲者视图计时，暂停时间不计入，黑屏时间计入当前页");
  const delta = analysis.estimated_page_count ? `；差值 ${signedClock(analysis.total_seconds - analysis.estimated_total_seconds)}` : "";
  lines.push(`- 实际总用时 ${clock(analysis.total_seconds)}；推算合计 ${analysis.estimated_page_count ? `${clock(analysis.estimated_total_seconds)}（${analysis.estimated_page_count}/${analysis.rows.length} 页有推算）` : "无"}${delta}`);
  lines.push(`- 现场标记：讲不顺 ${analysis.mark_counts.stumble} 处，观众有疑问 ${analysis.mark_counts.question} 处，跳过 ${analysis.mark_counts.skipped} 处`);
  lines.push("", "## 逐页用时", "", "| 页 | 标题 | 推算 | 实际 | 差值 | 进入次数 | 标记 |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of analysis.rows) {
    const flags = [...row.marks.map((kind) => MARK_LABELS[kind]), ...(row.overtime ? ["超时"] : []), ...(row.skipped && !row.marks.includes("skipped") ? [skipReason(row.skipped_reason)] : [])];
    lines.push(`| ${row.page} | ${cell(row.title)} | ${row.estimated_seconds ? clock(row.estimated_seconds) : "—"} | ${clock(row.actual_seconds)} | ${row.delta_seconds !== undefined ? signedClock(row.delta_seconds) : "—"} | ${row.visit_count} | ${flags.join("、") || "—"} |`);
  }
  const skipped = analysis.rows.filter((row) => row.skipped);
  lines.push("", "## 被跳过的页", "");
  if (skipped.length) for (const row of skipped) lines.push(`- 第 ${row.page} 页「${row.title}」：${skipReason(row.skipped_reason)}`);
  else lines.push("- 无");
  const overtime = analysis.rows.filter((row) => row.overtime);
  lines.push("", "## 超时的页", "", `判定：实际用时超过推算的 ${Math.round((OVERTIME_RATIO - 1) * 100)}% 且至少多 ${OVERTIME_MIN_SECONDS} 秒。`, "");
  if (overtime.length) for (const row of overtime) lines.push(`- 第 ${row.page} 页「${row.title}」：实际 ${clock(row.actual_seconds)}，推算 ${clock(row.estimated_seconds)}（${signedClock(row.delta_seconds)}）`);
  else lines.push("- 无");
  lines.push("", "## 现场标记汇总", "");
  for (const kind of DELIVERY_MARK_KINDS) {
    const marked = analysis.rows.filter((row) => row.marks.includes(kind));
    lines.push(`### ${MARK_LABELS[kind]}`, "");
    if (marked.length) for (const row of marked) lines.push(`- 第 ${row.page} 页「${row.title}」（标记于 ${row.mark_times.filter((mark) => mark.kind === kind).map((mark) => clock(mark.at_seconds)).join("、")}）`);
    else lines.push("- 无");
    lines.push("");
  }
  lines.push("## 连续两场被标记的页", "");
  if (repeated.pages.length) for (const page of repeated.pages) {
    lines.push(`- 第 ${page.page} 页${page.title ? `「${page.title}」` : ""}：${page.deliveries.map((entry) => `${entry.date} ${entry.signals.map((kind) => MARK_LABELS[kind]).join("、")}`).join("；")}`);
    for (const suggestion of page.suggestions) lines.push(`  - 建议：${suggestion}`);
  }
  else lines.push("- 无（需要至少两场记录，且同一页两场都被标记、跳过或超时）");
  if (analysis.warnings.length) {
    lines.push("", "## 匹配提示", "");
    for (const warning of analysis.warnings) lines.push(`- ${warning}`);
  }
  lines.push("", "## 回流", "", "- 逐页结果已追加到对应 PageSpec 的 `delivery_feedback`；下一版改讲稿或排版前先读本报告与 `delivery_feedback`。", "- `pptops review` 会在同一页连续两场被标记时给出 `delivery-feedback` 提示（不阻断）。", "");
  return `${lines.join("\n")}`;
}

function orderedFeedback(entries) {
  return [...(entries ?? [])].map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.index - b.index).map(({ entry }) => entry);
}
function signalsOf(entry) {
  const signals = [...entry.marks];
  if (entry.skipped && !signals.includes("skipped")) signals.push("skipped");
  if (entry.overtime) signals.push("overtime");
  return signals;
}
function skipReason(reason) { return { marked: "现场标记跳过", not_shown: "未展示", flicked_past: `停留不足 ${SKIP_DWELL_SECONDS} 秒` }[reason] ?? "跳过"; }
function clock(seconds) {
  const total = Math.round(Math.abs(seconds));
  const minutes = Math.floor(total / 60), rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
function signedClock(seconds) { return `${seconds < 0 ? "-" : "+"}${clock(seconds)}`; }
function cell(value) { return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " "); }
function round1(value) { return Math.round(value * 10) / 10; }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasText(value) { return typeof value === "string" && value.trim() !== ""; }
function isSeconds(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isIso(value) { return typeof value === "string" && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value)); }
function allowKeys(value, keys, field, errors) { for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${field}.${key} is not allowed`); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

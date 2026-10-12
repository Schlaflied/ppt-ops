import { createHash } from "node:crypto";
import {
  COUNTING_RULE, TRANSITION_MAX_WORDS, allocateTalkBudget, countScriptWords, normalizeScriptReviewConfig,
  normalizeTalkBudget, scriptSegments, splitSentences, wordsToSeconds, DEFAULT_WORDS_PER_MINUTE
} from "../contracts/talk-budget.js";
import { resolvePageDuration } from "../delivery/retro.js";

export const SCRIPT_REVIEW_JSON = "script-review.json";
export const SCRIPT_REVIEW_MARKDOWN = "script-review.md";

const DASH = /——|—|–|(?<!-)--(?!-)/gu;
const NUMBER = /\d+(?:\.\d+)?/gu;

export function hasSpeakerScriptReview(project) {
  return project?.project?.talk_budget !== undefined || project?.project?.script_review !== undefined;
}

// Reviews authored speaker_notes against the optional talk_budget and script_review config.
// Returns null when the project declares neither, so legacy projects keep their existing review output.
export function reviewSpeakerScript(project, { baseline, includeScript = false, force = false } = {}) {
  if (!force && !hasSpeakerScriptReview(project)) return null;
  const pages = project.pages ?? [];
  const budget = normalizeTalkBudget(project.project.talk_budget);
  const config = normalizeScriptReviewConfig(project.project.script_review);
  const wordsPerMinute = budget?.words_per_minute ?? DEFAULT_WORDS_PER_MINUTE;
  const allocation = budget ? allocateTalkBudget(pages, project.project.talk_budget) : null;
  const targetByPage = new Map((allocation?.pages ?? []).map((item) => [item.page, item]));
  const segments = scriptSegments(pages);
  const findings = [];

  const pageResults = segments.map(({ page, role, host, merged }) => {
    const words = countScriptWords(page.speaker_notes);
    const segmentWords = host ? 0 : words + merged.reduce((sum, item) => sum + countScriptWords(item.speaker_notes), 0);
    const target = targetByPage.get(page.page);
    const estimatedSeconds = wordsToSeconds(host ? 0 : segmentWords, wordsPerMinute);
    const resolved = resolvePageDuration(page);
    const rehearsed = resolved?.source === "rehearsed" ? resolved : null;
    return {
      page: page.page,
      ...(page.id ? { id: page.id } : {}),
      script_role: role,
      ...(host ? { merged_into: host.page } : {}),
      ...(merged.length ? { merged_with: merged.map((item) => item.page) } : {}),
      has_script: words > 0,
      words,
      segment_words: segmentWords,
      sentences: splitSentences(page.speaker_notes).length,
      ...(target ? { target_words: target.target_words, min_words: target.min_words, max_words: target.max_words, deviation_percent: deviation(segmentWords, target.target_words) } : {}),
      estimated_seconds: estimatedSeconds,
      duration_seconds: rehearsed ? rehearsed.seconds : estimatedSeconds,
      duration_source: rehearsed ? "rehearsed" : "estimated",
      ...(rehearsed ? { rehearsed_seconds: rehearsed.seconds, rehearsed_date: rehearsed.date, rehearsed_delivery_id: rehearsed.delivery_id } : {}),
      ...(page.estimated_duration_seconds ? { declared_estimate_seconds: page.estimated_duration_seconds, declared_estimate_source: "estimated" } : {}),
      ...(includeScript && page.speaker_notes !== undefined ? { script: page.speaker_notes } : {})
    };
  });

  const totalWords = pageResults.reduce((sum, item) => sum + item.words, 0);
  const totalDeviation = budget ? deviation(totalWords, budget.target_words) : null;
  const rehearsedPages = pageResults.filter((item) => item.duration_source === "rehearsed").map((item) => item.page);
  const totalSeconds = pageResults.reduce((sum, item) => sum + item.duration_seconds, 0);
  const totalDurationSource = rehearsedPages.length === 0 ? "estimated" : rehearsedPages.length === pageResults.length ? "rehearsed" : "mixed";
  const durationMinutes = round(totalSeconds / 60);
  const durationDeviation = budget && budget.speaking_minutes > 0 ? round(((totalSeconds / 60 - budget.speaking_minutes) / budget.speaking_minutes) * 100, 1) : null;

  if (budget) {
    for (const result of pageResults) {
      const segment = segments.find(({ page }) => page.page === result.page);
      if (segment.host) continue;
      if (!result.has_script && segment.merged.every((item) => countScriptWords(item.speaker_notes) === 0) && result.script_role !== "reference") {
        findings.push(finding(result.page, "script-missing", { script_role: result.script_role, target_words: result.target_words }, "Write a spoken script for this page, or mark it script_role reference / merge it into a neighbouring page."));
        continue;
      }
      if (result.script_role === "transition" && !segment.merged.length && (result.sentences > 1 || result.words > TRANSITION_MAX_WORDS)) {
        findings.push(finding(result.page, "script-transition-length", { words: result.words, sentences: result.sentences, max_words: TRANSITION_MAX_WORDS, max_sentences: 1 }, "Compress this transition to one spoken sentence."));
        continue;
      }
      if (result.target_words === undefined || result.segment_words === 0 && result.script_role === "reference") continue;
      const over = result.segment_words > result.max_words;
      const under = result.script_role === "core" && result.segment_words < result.min_words;
      if (over || under) findings.push(finding(result.page, "script-page-budget", {
        script_role: result.script_role, words: result.segment_words, target_words: result.target_words,
        min_words: result.min_words, max_words: result.max_words, deviation_percent: result.deviation_percent
      }, over ? `Compress to about ${result.target_words} words.` : `Expand to about ${result.target_words} words; core pages carry the argument.`));
    }
  }

  const compression = budget && totalWords > budget.target_words ? compressionPlan(pageResults, segments, totalWords - budget.target_words) : null;
  if (budget && Math.abs(totalDeviation) > budget.tolerance_percent) {
    const overBudget = totalDeviation > 0;
    findings.push(finding(null, "script-total-budget", {
      total_words: totalWords, target_words: budget.target_words, deviation_percent: totalDeviation,
      estimated_minutes: round(totalWords / budget.words_per_minute), speaking_minutes: budget.speaking_minutes,
      tolerance_percent: budget.tolerance_percent, duration_source: "estimated"
    }, overBudget
      ? `Over budget by ${totalWords - budget.target_words} words. Compress pages ${compression.suggestions.map(({ page }) => page).join(", ") || "(none identified)"} first.`
      : `Under budget by ${budget.target_words - totalWords} words. Expand core pages or shorten total_minutes.`));
  }
  if (budget && rehearsedPages.length && durationDeviation !== null && Math.abs(durationDeviation) > budget.tolerance_percent) {
    const overTime = durationDeviation > 0;
    findings.push(finding(null, "script-total-duration", {
      duration_minutes: durationMinutes, speaking_minutes: budget.speaking_minutes, deviation_percent: durationDeviation,
      tolerance_percent: budget.tolerance_percent, duration_source: totalDurationSource, rehearsed_pages: rehearsedPages
    }, overTime
      ? `Rehearsed and estimated timing totals ${durationMinutes} min against ${budget.speaking_minutes} speaking minutes. Cut pages that ran long in the latest delivery first.`
      : `Rehearsed and estimated timing totals ${durationMinutes} min against ${budget.speaking_minutes} speaking minutes. There is room to expand core pages.`));
  }

  const bannedHits = [];
  const phraseCounts = Object.fromEntries(config.banned_phrases.map((phrase) => [phrase, 0]));
  let dashTotal = 0;
  const quoteFamilies = new Map();
  for (const page of pages) {
    const notes = typeof page.speaker_notes === "string" ? page.speaker_notes : "";
    if (!notes) continue;
    for (const sentence of splitSentences(notes)) for (const phrase of config.banned_phrases) {
      const count = sentence.split(phrase).length - 1;
      if (count === 0) continue;
      phraseCounts[phrase] += count;
      bannedHits.push({ page: page.page, phrase, count, sentence });
      findings.push(finding(page.page, "script-banned-phrase", { phrase, count, sentence }, `Remove or rephrase "${phrase}".`));
    }
    const dashes = notes.match(DASH)?.length ?? 0;
    dashTotal += dashes;
    if (dashes > config.max_dashes_per_page) findings.push(finding(page.page, "script-dash-limit", { dashes, max_dashes_per_page: config.max_dashes_per_page }, "Replace dashes with full stops or commas; spoken scripts read better in short sentences."));
    for (const issue of quoteIssues(notes, config.quote_style)) findings.push(finding(page.page, "script-quote-style", issue, issue.suggestion));
    const families = quoteFamiliesIn(notes);
    for (const family of families) quoteFamilies.set(family, [...(quoteFamilies.get(family) ?? []), page.page]);
  }
  if (config.quote_style === "consistent" && quoteFamilies.size > 1) {
    findings.push(finding(null, "script-quote-style", { reason: "mixed_quote_styles", pages_by_style: Object.fromEntries(quoteFamilies) }, "Use one quotation style across the script, for example “…” or 「…」."));
  }

  for (const { page, host } of segments) {
    if (host) continue;
    const numbers = emphasizedNumbers(page);
    for (const merged of segments.filter((segment) => segment.host === page)) numbers.push(...emphasizedNumbers(merged.page));
    if (numbers.length === 0) continue;
    const spoken = [page, ...segments.filter((segment) => segment.host === page).map((segment) => segment.page)].map((item) => item.speaker_notes ?? "").join("\n");
    if (countScriptWords(spoken) === 0) continue;
    const normalizedSpoken = normalizeNumbers(spoken);
    const missing = [...new Set(numbers)].filter((number) => !new RegExp(`(?<![\\d.])${number.replace(".", "\\.")}(?!\\d|\\.\\d)`, "u").test(normalizedSpoken));
    if (missing.length) findings.push(finding(page.page, "script-screen-number-missing", { numbers: missing }, "Say the numbers that the slide emphasizes so the script and the three-second message agree."));
  }

  const skippedPages = pageResults.filter((item) => !item.merged_into && !item.has_script && item.segment_words === 0).map((item) => item.page);
  const audit = {
    deleted_pages: baseline ? baselineDeletions(baseline, pageResults) : [],
    skipped_pages: skippedPages,
    merged_pages: pageResults.filter((item) => item.merged_with).map((item) => ({ page: item.page, merged_with: item.merged_with })),
    banned_phrase_counts: phraseCounts,
    banned_phrase_hits: bannedHits,
    dash_count: dashTotal,
    total_words: totalWords,
    ...(budget ? { target_words: budget.target_words, budget_ratio: round(totalWords / budget.target_words, 3) } : {}),
    ...(baseline ? { baseline_words: baseline.total_words, compression_ratio: baseline.total_words > 0 ? round(totalWords / baseline.total_words, 3) : null, compression_basis: "baseline_script_review" } : { compression_ratio: null, compression_basis: "not_recorded" })
  };

  return {
    schema_version: "1.0",
    kind: "speaker_script_review",
    project: project.project.name,
    script_revision: scriptRevision(project),
    status: findings.length === 0 ? "passed" : "failed",
    counting: COUNTING_RULE,
    budget,
    config,
    summary: {
      total_words: totalWords,
      target_words: budget?.target_words ?? null,
      deviation_percent: totalDeviation,
      estimated_minutes: round(totalWords / wordsPerMinute),
      speaking_minutes: budget?.speaking_minutes ?? null,
      total_duration_seconds: totalSeconds,
      duration_minutes: durationMinutes,
      duration_deviation_percent: durationDeviation,
      duration_source: totalDurationSource,
      rehearsed_timing: rehearsedPages.length ? "latest_delivery" : "not_claimed",
      rehearsed_pages: rehearsedPages,
      finding_count: findings.length
    },
    pages: pageResults,
    ...(compression ? { compression_suggestions: compression.suggestions, remaining_excess_words: compression.remaining } : {}),
    findings,
    audit
  };
}

export function scriptRevision(project) {
  const value = {
    talk_budget: project.project?.talk_budget ?? null,
    script_review: project.project?.script_review ?? null,
    pages: (project.pages ?? []).map(({ page, id, script_role, merged_with, speaker_notes, screen_text, three_second_message }) => ({ page, id: id ?? null, script_role: script_role ?? null, merged_with: merged_with ?? null, speaker_notes: speaker_notes ?? null, screen_text: screen_text ?? null, three_second_message: three_second_message ?? null }))
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function renderScriptReviewMarkdown(review) {
  const lines = [`# Speaker script review: ${review.project}`, ""];
  const { summary, budget, audit } = review;
  lines.push(`- Status: ${review.status}`, `- Script revision: \`${review.script_revision}\``, `- Counting: ${review.counting.description}`);
  if (budget) lines.push(`- Budget: ${budget.total_minutes} min total, ${budget.reserve_minutes} min reserve, ${budget.words_per_minute} words/min → ${budget.target_words} words (±${budget.tolerance_percent}%)`);
  lines.push(`- Script: ${summary.total_words} words ≈ ${summary.estimated_minutes} min (estimated from words)${summary.deviation_percent === null ? "" : `, deviation ${summary.deviation_percent}%`}`, `- Timing: ${summary.duration_minutes} min (${summary.duration_source}; rehearsed timing ${summary.rehearsed_timing}${summary.rehearsed_pages.length ? `, pages ${summary.rehearsed_pages.join(", ")}` : ""})${summary.duration_deviation_percent === null ? "" : `, deviation ${summary.duration_deviation_percent}%`}`, "");
  lines.push("## Audit log", "");
  lines.push(`- Deleted pages: ${list(audit.deleted_pages)}`, `- Skipped pages (no narration): ${list(audit.skipped_pages)}`);
  lines.push(`- Merged pages: ${audit.merged_pages.length ? audit.merged_pages.map(({ page, merged_with }) => `${page} ← ${merged_with.join(", ")}`).join("; ") : "none"}`);
  lines.push(`- Compression ratio: ${audit.compression_ratio ?? "not recorded (run script-review with --baseline <earlier script-review.json>)"}${audit.budget_ratio === undefined ? "" : `; budget ratio ${audit.budget_ratio}`}`);
  lines.push(`- Dashes: ${audit.dash_count}`);
  const counts = Object.entries(audit.banned_phrase_counts).filter(([, count]) => count > 0);
  lines.push(`- Banned phrases: ${counts.length ? counts.map(([phrase, count]) => `${phrase} ×${count}`).join(", ") : "none"}`, "");
  lines.push("## Pages", "", "| Page | Role | Words | Target | Deviation | Est. seconds | Seconds (source) |", "|---|---|---|---|---|---|---|");
  for (const page of review.pages) lines.push(`| ${page.page}${page.merged_into ? ` (→${page.merged_into})` : ""} | ${page.script_role} | ${page.segment_words} | ${page.target_words ?? "-"} | ${page.deviation_percent ?? "-"}${page.deviation_percent === undefined ? "" : "%"} | ${page.estimated_seconds} | ${page.duration_seconds} (${page.duration_source}${page.rehearsed_date ? ` ${page.rehearsed_date}` : ""}) |`);
  lines.push("");
  if (review.compression_suggestions?.length) {
    lines.push("## Compression suggestions", "");
    for (const item of review.compression_suggestions) lines.push(`- Page ${item.page} (${item.script_role}): ${item.action}, ${item.words} → ${item.suggested_words} words`);
    lines.push("");
  }
  lines.push("## Findings", "");
  if (review.findings.length === 0) lines.push("None.");
  for (const item of review.findings) lines.push(`- ${item.page === null ? "Deck" : `Page ${item.page}`} · ${item.check}: ${item.suggestion} \`${JSON.stringify(item.evidence)}\``);
  return `${lines.join("\n")}\n`;
}

function compressionPlan(pageResults, segments, excess) {
  const suggestions = [];
  let remaining = excess;
  const take = (result, suggestedWords, action) => {
    if (remaining <= 0) return;
    const cut = result.segment_words - suggestedWords;
    if (cut <= 0) return;
    suggestions.push({ page: result.page, script_role: result.script_role, action, words: result.segment_words, target_words: result.target_words, suggested_words: suggestedWords, cut_words: cut });
    remaining -= cut;
  };
  const hosts = pageResults.filter((item) => !item.merged_into);
  const isPlainTransition = (item) => item.script_role === "transition" && !segments.find(({ page }) => page.page === item.page).merged.length;
  for (const item of hosts.filter(isPlainTransition).sort(byOverrun)) take(item, Math.min(item.segment_words, TRANSITION_MAX_WORDS), "one_sentence");
  for (const item of hosts.filter((entry) => entry.script_role === "reference").sort((left, right) => right.segment_words - left.segment_words || left.page - right.page)) take(item, 0, "skip");
  for (const item of hosts.filter((entry) => !isPlainTransition(entry) && entry.script_role !== "reference").sort(byOverrun)) take(item, Math.min(item.segment_words, item.target_words), "compress");
  return { suggestions, remaining: Math.max(0, remaining) };
}

function byOverrun(left, right) { return (right.segment_words - right.target_words) - (left.segment_words - left.target_words) || left.page - right.page; }

function quoteIssues(notes, style) {
  const issues = [];
  const hasCjk = countScriptWords(notes.replace(/[A-Za-z0-9]/g, "")) > 0;
  if (hasCjk && notes.includes("\"")) issues.push({ reason: "straight_quotes", count: notes.split("\"").length - 1, suggestion: "Use “…” or 「…」 instead of straight quotes in Chinese scripts." });
  const open = notes.split("“").length - 1, close = notes.split("”").length - 1;
  if (open !== close) issues.push({ reason: "unbalanced_quotes", open, close, suggestion: "Balance the opening and closing quotation marks." });
  if (style === "curly" && /[「」『』]/u.test(notes)) issues.push({ reason: "unexpected_style", expected: "curly", suggestion: "Use “…” quotation marks as configured." });
  if (style === "corner" && /[“”‘’]/u.test(notes)) issues.push({ reason: "unexpected_style", expected: "corner", suggestion: "Use 「…」 quotation marks as configured." });
  return issues;
}

function quoteFamiliesIn(notes) {
  const families = [];
  if (/[“”]/u.test(notes)) families.push("curly");
  if (/[「」『』]/u.test(notes)) families.push("corner");
  if (notes.includes("\"")) families.push("straight");
  return families;
}

function emphasizedNumbers(page) {
  const screen = page.screen_text ?? {};
  const text = [screen.title, screen.subtitle, ...(Array.isArray(screen.body) ? screen.body : []), page.three_second_message].filter((value) => typeof value === "string").join("\n");
  return normalizeNumbers(text).match(NUMBER) ?? [];
}

function normalizeNumbers(text) { return text.normalize("NFKC").replace(/(\d),(?=\d{3}\b)/gu, "$1"); }

function baselineDeletions(baseline, pageResults) {
  const current = new Map(pageResults.map((item) => [item.id ?? item.page, item]));
  return (baseline.pages ?? []).filter((item) => (item.words ?? 0) > 0).filter((item) => {
    const now = current.get(item.id ?? item.page);
    return !now || (!now.has_script && !now.merged_into);
  }).map((item) => item.page);
}

function finding(page, check, evidence, suggestion) { return { page, check, severity: "warning", evidence, suggestion }; }
function deviation(actual, target) { return target > 0 ? round(((actual - target) / target) * 100, 1) : null; }
function round(value, digits = 1) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
function list(values) { return values.length ? values.join(", ") : "none"; }

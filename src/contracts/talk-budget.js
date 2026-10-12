// Talk budget contract: counting rules, validation, and deterministic per-page allocation.
// The agent authors speaker scripts; this module only computes budgets and measures text.

export const SCRIPT_ROLES = Object.freeze(["transition", "core", "reference"]);
export const DEFAULT_SCRIPT_ROLE = "core";
export const DEFAULT_WORDS_PER_MINUTE = 250;
export const DEFAULT_TOLERANCE_PERCENT = 10;
export const PAGE_TOLERANCE_PERCENT = 30;
export const TRANSITION_TARGET_WORDS = 30;
export const TRANSITION_MAX_WORDS = 40;
export const ROLE_WEIGHTS = Object.freeze({ core: 1, reference: 0.4 });
export const QUOTE_STYLES = Object.freeze(["consistent", "curly", "corner"]);
export const DEFAULT_BANNED_PHRASES = Object.freeze(["说白了", "简单来说", "换句话说", "综上所述", "总而言之", "众所周知"]);
export const DEFAULT_MAX_DASHES_PER_PAGE = 2;
export const COUNTING_RULE = Object.freeze({
  id: "cjk-character-plus-latin-word",
  description: "Each Han, Hiragana, Katakana, or Hangul character counts as one word; each run of Latin letters or digits (including internal ' . - such as GPT-4 or 3.5) counts as one word; punctuation and whitespace are not counted."
});

const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD = /[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu;

export function countScriptWords(text) {
  if (typeof text !== "string" || text.trim() === "") return 0;
  const cjk = text.match(CJK_CHARACTER)?.length ?? 0;
  const latin = text.replace(CJK_CHARACTER, " ").match(LATIN_WORD)?.length ?? 0;
  return cjk + latin;
}

export function splitSentences(text) {
  if (typeof text !== "string") return [];
  return text.split(/(?<=[。！？!?；;…])|(?<=\.)\s+|\n+/u).map((sentence) => sentence.trim()).filter((sentence) => countScriptWords(sentence) > 0);
}

export function wordsToSeconds(words, wordsPerMinute = DEFAULT_WORDS_PER_MINUTE) {
  return Math.round((words / wordsPerMinute) * 60);
}

export function normalizeTalkBudget(budget) {
  if (!isObject(budget)) return null;
  const wordsPerMinute = budget.words_per_minute ?? DEFAULT_WORDS_PER_MINUTE;
  const reserveMinutes = budget.reserve_minutes ?? 0;
  const speakingMinutes = budget.total_minutes - reserveMinutes;
  return {
    total_minutes: budget.total_minutes,
    words_per_minute: wordsPerMinute,
    reserve_minutes: reserveMinutes,
    speaking_minutes: speakingMinutes,
    tolerance_percent: budget.tolerance_percent ?? DEFAULT_TOLERANCE_PERCENT,
    target_words: Math.round(speakingMinutes * wordsPerMinute)
  };
}

export function normalizeScriptReviewConfig(config) {
  const value = isObject(config) ? config : {};
  return {
    banned_phrases: Array.isArray(value.banned_phrases) ? [...value.banned_phrases] : [...DEFAULT_BANNED_PHRASES],
    max_dashes_per_page: value.max_dashes_per_page ?? DEFAULT_MAX_DASHES_PER_PAGE,
    quote_style: value.quote_style ?? "consistent"
  };
}

export function validateTalkBudget(value, prefix = "talk_budget") {
  if (value === undefined) return [];
  if (!isObject(value)) return [`${prefix} must be an object`];
  const errors = [];
  if (!isPositive(value.total_minutes)) errors.push(`${prefix}.total_minutes must be a positive number`);
  if (value.words_per_minute !== undefined && !isPositive(value.words_per_minute)) errors.push(`${prefix}.words_per_minute must be a positive number`);
  if (value.reserve_minutes !== undefined && !(Number.isFinite(value.reserve_minutes) && value.reserve_minutes >= 0)) errors.push(`${prefix}.reserve_minutes must be a non-negative number`);
  else if (isPositive(value.total_minutes) && (value.reserve_minutes ?? 0) >= value.total_minutes) errors.push(`${prefix}.reserve_minutes must be less than total_minutes`);
  if (value.tolerance_percent !== undefined && !(Number.isFinite(value.tolerance_percent) && value.tolerance_percent > 0 && value.tolerance_percent <= 100)) errors.push(`${prefix}.tolerance_percent must be greater than 0 and at most 100`);
  for (const key of Object.keys(value)) if (!["total_minutes", "words_per_minute", "reserve_minutes", "tolerance_percent"].includes(key)) errors.push(`${prefix}.${key} is not supported`);
  return errors;
}

export function validateScriptReviewConfig(value, prefix = "script_review") {
  if (value === undefined) return [];
  if (!isObject(value)) return [`${prefix} must be an object`];
  const errors = [];
  if (value.banned_phrases !== undefined && (!Array.isArray(value.banned_phrases) || value.banned_phrases.some((item) => typeof item !== "string" || item.trim() === "") || new Set(value.banned_phrases).size !== value.banned_phrases.length)) errors.push(`${prefix}.banned_phrases must contain unique non-empty strings`);
  if (value.max_dashes_per_page !== undefined && !(Number.isInteger(value.max_dashes_per_page) && value.max_dashes_per_page >= 0)) errors.push(`${prefix}.max_dashes_per_page must be a non-negative integer`);
  if (value.quote_style !== undefined && !QUOTE_STYLES.includes(value.quote_style)) errors.push(`${prefix}.quote_style is invalid: ${value.quote_style}`);
  for (const key of Object.keys(value)) if (!["banned_phrases", "max_dashes_per_page", "quote_style"].includes(key)) errors.push(`${prefix}.${key} is not supported`);
  return errors;
}

export function validateScriptPageFields(page) {
  const errors = [];
  if (page?.script_role !== undefined && !SCRIPT_ROLES.includes(page.script_role)) errors.push(`script_role is invalid: ${page.script_role}`);
  if (page?.merged_with !== undefined) {
    const refs = page.merged_with;
    if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => !isPageRef(ref))) errors.push("merged_with must be a non-empty array of page numbers or page ids");
    else if (new Set(refs.map(String)).size !== refs.length) errors.push("merged_with must not contain duplicates");
  }
  return errors;
}

// Cross-page rules: refs resolve, never point at the host itself, a page joins at most one host, and hosts are not merged elsewhere.
export function validateScriptStructure(pages) {
  const errors = [];
  if (!Array.isArray(pages)) return errors;
  const owner = new Map();
  for (const page of pages) {
    if (!Array.isArray(page?.merged_with)) continue;
    for (const ref of page.merged_with) {
      const target = resolvePageRef(pages, ref);
      if (!target) { errors.push(`page ${page.page}: merged_with references missing page: ${ref}`); continue; }
      if (target === page) { errors.push(`page ${page.page}: merged_with must not reference itself`); continue; }
      if (owner.has(target)) errors.push(`page ${target.page}: merged into more than one page (${owner.get(target).page}, ${page.page})`);
      else owner.set(target, page);
    }
  }
  for (const [target] of owner) if (Array.isArray(target.merged_with) && target.merged_with.length > 0) errors.push(`page ${target.page}: a merged page cannot host other pages`);
  return errors;
}

export function resolvePageRef(pages, ref) {
  if (Number.isInteger(ref)) return pages.find((page) => page?.page === ref);
  if (typeof ref === "string") return pages.find((page) => page?.id === ref);
  return undefined;
}

// Groups pages into narration segments. A host page carries its own script plus the pages listed in merged_with.
export function scriptSegments(pages) {
  const hostOf = new Map();
  for (const page of pages) for (const ref of page.merged_with ?? []) {
    const target = resolvePageRef(pages, ref);
    if (target && target !== page && !hostOf.has(target)) hostOf.set(target, page);
  }
  return pages.map((page) => ({
    page,
    role: SCRIPT_ROLES.includes(page.script_role) ? page.script_role : DEFAULT_SCRIPT_ROLE,
    host: hostOf.get(page) ?? null,
    merged: pages.filter((candidate) => hostOf.get(candidate) === page)
  }));
}

// Deterministic allocation: transitions get one short sentence, the rest is split by role weight
// (core 1.0, reference 0.4) with largest-remainder rounding; merged pages fold into their host.
export function allocateTalkBudget(pages, budget) {
  const normalized = normalizeTalkBudget(budget);
  if (!normalized || !Array.isArray(pages) || pages.length === 0) return null;
  const segments = scriptSegments(pages);
  const transitionWords = Math.max(0, Math.min(TRANSITION_TARGET_WORDS, Math.floor(normalized.target_words / pages.length)));
  const raw = new Map(segments.map(({ page, role }) => [page, role === "transition" ? transitionWords : 0]));
  const weighted = segments.filter(({ role }) => role !== "transition");
  const remaining = Math.max(0, normalized.target_words - [...raw.values()].reduce((sum, value) => sum + value, 0));
  const totalWeight = weighted.reduce((sum, { role }) => sum + ROLE_WEIGHTS[role], 0);
  if (totalWeight > 0) {
    const quotas = weighted.map(({ page, role }, index) => {
      const exact = (remaining * ROLE_WEIGHTS[role]) / totalWeight;
      return { page, index, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
    });
    let leftover = remaining - quotas.reduce((sum, quota) => sum + quota.floor, 0);
    for (const quota of [...quotas].sort((left, right) => right.fraction - left.fraction || left.index - right.index)) {
      if (leftover <= 0) break;
      quota.floor += 1; leftover -= 1;
    }
    for (const quota of quotas) raw.set(quota.page, quota.floor);
  }
  const allocation = segments.map(({ page, role, host, merged }) => {
    const target = host ? 0 : raw.get(page) + merged.reduce((sum, item) => sum + raw.get(item), 0);
    const tolerance = PAGE_TOLERANCE_PERCENT / 100;
    const range = host ? { min_words: 0, max_words: 0 }
      : role === "transition" && merged.length === 0 ? { min_words: 1, max_words: TRANSITION_MAX_WORDS, max_sentences: 1 }
      : role === "reference" ? { min_words: 0, max_words: Math.ceil(target * (1 + tolerance)) }
      : { min_words: Math.floor(target * (1 - tolerance)), max_words: Math.ceil(target * (1 + tolerance)) };
    return {
      page: page.page,
      ...(page.id ? { id: page.id } : {}),
      script_role: role,
      ...(host ? { merged_into: host.page } : {}),
      ...(merged.length ? { merged_with: merged.map((item) => item.page) } : {}),
      target_words: target,
      ...range
    };
  });
  return { budget: normalized, counting: COUNTING_RULE, allocated_words: allocation.reduce((sum, item) => sum + item.target_words, 0), pages: allocation };
}

function isPageRef(ref) { return (Number.isInteger(ref) && ref >= 1) || (typeof ref === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(ref)); }
function isPositive(value) { return Number.isFinite(value) && value > 0; }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

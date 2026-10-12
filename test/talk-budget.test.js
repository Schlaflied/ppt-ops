import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { allocateTalkBudget, countScriptWords, normalizeTalkBudget, splitSentences, validateScriptPageFields, validateScriptReviewConfig, validateScriptStructure, validateTalkBudget } from "../src/contracts/talk-budget.js";
import { validateV1Entity } from "../src/contracts/v1.js";
import { validatePage } from "../src/core/validate.js";
import { writeMigratedProject } from "../src/migrations/foundation-to-v1.js";
import { renderScriptReviewMarkdown, reviewSpeakerScript } from "../src/qa/speaker-script.js";
import { reviewProject } from "../src/review/index.js";
import { readProject } from "../src/core/project.js";
import { seedAcceptedBoundaryImages } from "./support/accepted-boundaries.js";

const execFileAsync = promisify(execFile);
const cli = path.resolve("src/cli.js");
const demo = path.resolve("examples/demo-project");

const page = (number, fields = {}) => ({ page: number, id: `page-${String(number).padStart(3, "0")}`, task: "t", three_second_message: "m", relation: "hero", screen_text: { title: "Title" }, visual_job: "v", asset_slots: [], status: "draft", ...fields });
const chars = (count, char = "讲") => char.repeat(count) + "。";

test("counts each CJK character and each Latin word or number once", () => {
  assert.equal(countScriptWords("我们用 GPT-4 讲 3.5 分钟。"), 8);
  assert.equal(countScriptWords("Hello, world! 你好"), 4);
  assert.equal(countScriptWords("——“”。，"), 0);
  assert.equal(countScriptWords(undefined), 0);
  assert.deepEqual(splitSentences("第一句。第二句！Third one. Fourth"), ["第一句。", "第二句！", "Third one.", "Fourth"]);
});

test("normalizes the budget with 250 words per minute and reserve time", () => {
  assert.deepEqual(normalizeTalkBudget({ total_minutes: 20, reserve_minutes: 2 }), { total_minutes: 20, words_per_minute: 250, reserve_minutes: 2, speaking_minutes: 18, tolerance_percent: 10, target_words: 4500 });
});

test("allocates deterministically: transitions get one sentence, core outweighs reference, merges fold into the host", () => {
  const pages = [page(1, { script_role: "transition" }), page(2, { merged_with: [3] }), page(3), page(4, { script_role: "reference" }), page(5)];
  const allocation = allocateTalkBudget(pages, { total_minutes: 10 });
  const byPage = Object.fromEntries(allocation.pages.map((item) => [item.page, item]));
  assert.equal(allocation.allocated_words, 2500);
  assert.equal(byPage[1].target_words, 30);
  assert.equal(byPage[1].max_sentences, 1);
  assert.equal(byPage[3].target_words, 0);
  assert.equal(byPage[3].merged_into, 2);
  assert.deepEqual(byPage[2].merged_with, [3]);
  assert.ok(byPage[2].target_words > byPage[5].target_words);
  assert.ok(byPage[5].target_words > byPage[4].target_words);
  assert.deepEqual(allocateTalkBudget(pages, { total_minutes: 10 }), allocation);
});

test("validates talk_budget, script_review, script_role and merged_with", () => {
  assert.deepEqual(validateTalkBudget(undefined), []);
  assert.deepEqual(validateTalkBudget({ total_minutes: 30, words_per_minute: 220, reserve_minutes: 5 }), []);
  assert.ok(validateTalkBudget({ total_minutes: 0 }).some((error) => error.includes("total_minutes")));
  assert.ok(validateTalkBudget({ total_minutes: 5, reserve_minutes: 5 }).some((error) => error.includes("reserve_minutes")));
  assert.ok(validateTalkBudget({ total_minutes: 5, wpm: 1 }).some((error) => error.includes("wpm")));
  assert.ok(validateScriptReviewConfig({ banned_phrases: ["a", "a"], quote_style: "fancy" }).length === 2);
  assert.ok(validateScriptPageFields({ script_role: "intro" })[0].includes("script_role"));
  assert.ok(validateScriptPageFields({ merged_with: [] })[0].includes("merged_with"));
  assert.ok(validatePage(page(1, { script_role: "intro" })).some((error) => error.includes("script_role")));
  const structure = validateScriptStructure([page(1, { merged_with: [1] }), page(2, { merged_with: [3, "page-009"] }), page(3, { merged_with: [4] }), page(4)]);
  assert.ok(structure.some((error) => error.includes("itself")));
  assert.ok(structure.some((error) => error.includes("missing page: page-009")));
  assert.ok(structure.some((error) => error.includes("cannot host")));
  const project = { contract_version: "1.0", kind: "project", id: "p", title: "T", format: "16:9", source_ids: ["s"], outline_id: "o", theme_id: "t", asset_ids: [], talk_budget: { total_minutes: -1 } };
  assert.ok(validateV1Entity(project, "project").some((error) => error.includes("talk_budget.total_minutes")));
});

test("projects without talk_budget or script_review keep the previous review output", async () => {
  assert.equal(reviewSpeakerScript({ project: { name: "legacy" }, pages: [page(1, { speaker_notes: "说白了。" })] }), null);
  const project = await readProject(demo);
  const report = await reviewProject(project, { render: false });
  assert.equal(report.automated_checks.some(({ id }) => id === "speaker-script-review"), false);
});

test("reports budget deviation, compression candidates, banned phrases, dashes, quotes and missing screen numbers", () => {
  const pages = [
    page(1, { script_role: "transition", speaker_notes: "先看背景。再看问题。" }),
    page(2, { screen_text: { title: "成本下降 30%", body: ["1,200 家客户"] }, speaker_notes: `说白了，成本下降了30%——这很关键——非常关键——真的。${chars(400)}` }),
    page(3, { script_role: "reference", speaker_notes: `他说"可以"，也说“好”和「行」。${chars(300)}` }),
    page(4)
  ];
  const review = reviewSpeakerScript({ project: { name: "deck", talk_budget: { total_minutes: 2 } }, pages }, { includeScript: true });
  const checks = (name) => review.findings.filter(({ check }) => check === name);
  assert.equal(review.status, "failed");
  assert.equal(review.summary.target_words, 500);
  assert.equal(review.summary.duration_source, "estimated");
  assert.equal(review.summary.rehearsed_timing, "not_claimed");
  assert.ok(review.summary.deviation_percent > 10);
  const total = checks("script-total-budget")[0];
  assert.equal(total.page, null);
  assert.match(total.suggestion, /Compress pages/);
  assert.equal(review.compression_suggestions[0].page, 3);
  assert.equal(review.compression_suggestions[0].action, "skip");
  assert.equal(checks("script-transition-length")[0].page, 1);
  assert.equal(checks("script-missing")[0].page, 4);
  const banned = checks("script-banned-phrase")[0];
  assert.equal(banned.page, 2);
  assert.equal(banned.evidence.phrase, "说白了");
  assert.match(banned.evidence.sentence, /^说白了，成本下降了30%/);
  assert.equal(checks("script-dash-limit")[0].evidence.dashes, 3);
  assert.ok(checks("script-quote-style").some(({ page: number, evidence }) => number === 3 && evidence.reason === "straight_quotes"));
  assert.ok(checks("script-quote-style").some(({ page: number, evidence }) => number === null && evidence.reason === "mixed_quote_styles"));
  assert.deepEqual(checks("script-screen-number-missing")[0].evidence.numbers, ["1200"]);
  assert.equal(review.pages[1].script.startsWith("说白了"), true);
  assert.deepEqual(review.audit.banned_phrase_counts["说白了"], 1);
  assert.equal(review.audit.compression_basis, "not_recorded");
  assert.match(renderScriptReviewMarkdown(review), /## Audit log/);
});

test("merged pages are narrated by the host and baseline reviews record deletions and compression", () => {
  const pages = [page(1, { speaker_notes: chars(120), merged_with: ["page-002"] }), page(2, { screen_text: { title: "2026 目标" } }), page(3, { script_role: "reference" })];
  const project = { project: { name: "deck", talk_budget: { total_minutes: 1 }, script_review: { banned_phrases: [] } }, pages };
  const baseline = { kind: "speaker_script_review", total_words: 360, pages: [{ page: 1, id: "page-001", words: 200 }, { page: 3, id: "page-003", words: 160 }] };
  const review = reviewSpeakerScript(project, { baseline });
  assert.equal(review.pages[1].merged_into, 1);
  assert.deepEqual(review.audit.merged_pages, [{ page: 1, merged_with: [2] }]);
  assert.deepEqual(review.audit.deleted_pages, [3]);
  assert.equal(review.audit.compression_ratio, 0.333);
  assert.deepEqual(review.findings.find(({ check }) => check === "script-screen-number-missing").evidence.numbers, ["2026"]);
  assert.equal(review.findings.some(({ check }) => check === "script-missing"), false);
});

test("script-review CLI writes the per-page script, review includes the check, and handoff packages the audit log", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-talk-budget-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, "project");
  await writeMigratedProject(demo, project);
  await seedAcceptedBoundaryImages(project);
  const projectFile = path.join(project, "project.json"), pagesFile = path.join(project, "pages.json");
  const contract = JSON.parse(await fs.readFile(projectFile, "utf8"));
  await fs.writeFile(projectFile, JSON.stringify({ ...contract, talk_budget: { total_minutes: 0.4 } }));
  const pages = JSON.parse(await fs.readFile(pagesFile, "utf8"));
  pages[0].script_role = "transition";
  pages[0].speaker_notes = "先说这套流程为什么可控。";
  pages[1].speaker_notes = chars(85);
  await fs.writeFile(pagesFile, JSON.stringify(pages));

  const { stdout } = await execFileAsync(process.execPath, [cli, "script-review", project], { encoding: "utf8" });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.equal(result.pages[0].script, "先说这套流程为什么可控。");
  assert.equal(result.pages[1].target_words, 70);
  const saved = JSON.parse(await fs.readFile(path.join(project, "outputs", "script-review.json"), "utf8"));
  assert.equal(saved.script_revision, result.script_revision);
  assert.match(await fs.readFile(path.join(project, "outputs", "script-review.md"), "utf8"), /# Speaker script review/);

  await fs.writeFile(path.join(project, "outputs", "slides.html"), "artifact");
  const handoff = JSON.parse((await execFileAsync(process.execPath, [cli, "handoff", project, "--formats", "html", "--actor", "user:fixture"], { encoding: "utf8" })).stdout);
  assert.equal(handoff.script_review.status, "passed");
  assert.deepEqual(handoff.script_review.files, ["script-review.json", "script-review.md"]);
  assert.ok(handoff.outputs.some(({ name }) => name === "script-review.md"));
  const packaged = JSON.parse(await fs.readFile(path.join(path.dirname(handoff.manifest_file), "script-review.json"), "utf8"));
  assert.equal(packaged.pages[1].script, chars(85));
  const report = JSON.parse(await fs.readFile(path.join(project, "outputs", "review-report.json"), "utf8"));
  assert.equal(report.automated_checks.find(({ id }) => id === "speaker-script-review").required, false);
});

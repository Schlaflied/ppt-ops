import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../core/project.js";
import { renderCitation } from "../citations/manifest.js";
import { extractHtmlPages, inspectPdfPageConsistency } from "../qa/content-consistency.js";
import { captureSlidePreviews, findBrowser, printHtmlPdf } from "../qa/html.js";
import { digest } from "./outline.js";
import { hashFile } from "./pdf.js";

export const HANDOUT_DIR = "handout";
export const HANDOUT_EDITIONS = Object.freeze(["speaker", "audience"]);
export const HANDOUT_MANIFEST = "handout-manifest.json";

/** Normalizes the explicit handout edition choice; the speaker edition is the default. */
export function normalizeHandoutEditions(value) {
  const editions = value === undefined ? ["speaker"] : [...new Set((Array.isArray(value) ? value : [value]).map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!editions.length || editions.some(edition => !HANDOUT_EDITIONS.includes(edition))) throw failure("HANDOUT_EDITION_INVALID", `handout editions must be a non-empty subset of ${HANDOUT_EDITIONS.join(", ")}`);
  return HANDOUT_EDITIONS.filter(edition => editions.includes(edition));
}

/**
 * The handout is derived from an accepted, hash-bound HTML Build. Chromium is not required to select it:
 * without a browser the PDF and previews are recorded as unavailable instead of being substituted.
 */
export async function handoutCapability(build, reviews, root, options = {}) {
  if (!build.targets.includes("html")) return undefined;
  const review = [...reviews].reverse().find(item => item.build_id === build.id && item.state === "accepted");
  if (!review) return undefined;
  const file = `.pptops/builds/${build.id}/html/slides.html`;
  let sha256;
  try { sha256 = await hashFile(resolveProjectPath(root, file)); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  if (review.artifact_hashes?.[file] !== sha256) return undefined;
  const browser = await (options.findBrowser ?? findBrowser)();
  return { format: "html", file, sha256, review_id: review.id, components: browserComponents(browser) };
}

export function browserComponents(browser) {
  const unavailable = { status: "unavailable", reason: "Google Chrome or Chromium is unavailable; set PPT_OPS_CHROME or install Chromium" };
  return {
    pdf: browser ? { status: "available", exporter: "chromium-print" } : unavailable,
    previews: browser ? { status: "available", exporter: "chromium-screenshot" } : unavailable,
    script: { status: "available", source: "script-review" },
    index: { status: "available" }
  };
}

/**
 * Writes the handout into `<packageDir>/handout/`.
 *
 * @param {object} input
 * @param {object} input.project resolved project (the frozen Version / variant for formal handoffs)
 * @param {string} input.htmlFile the reviewed presentation HTML the handout derives from
 * @param {string} input.packageDir handoff package directory
 * @param {object} input.scriptReview `pptops script-review` result with `pages[].script`
 * @param {string[]} [input.editions] speaker and/or audience
 * @param {object} [input.citationManifest] governed citation manifest (#94) for the audience appendix
 * @param {object} [input.source] provenance copied into the manifest (Build, Version, Review, variant ...)
 */
export async function exportHandout({ project, htmlFile, packageDir, scriptReview, editions = ["speaker"], citationManifest, source = {}, scriptSource }, options = {}) {
  editions = normalizeHandoutEditions(editions);
  const directory = path.join(packageDir, HANDOUT_DIR);
  await fs.mkdir(directory, { recursive: false });
  const files = [];
  const write = async (relative, bytes) => {
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: "wx" });
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const entry = { name: `${HANDOUT_DIR}/${relative.split(path.sep).join("/")}`, source: "generated:handout", path: destination, bytes: buffer.byteLength, sha256: sha256(buffer) };
    files.push(entry);
    return entry;
  };

  const htmlBytes = await fs.readFile(htmlFile);
  const pages = handoutPages(project, extractHtmlPages(htmlBytes.toString("utf8")), scriptReview);
  if (!pages.length) throw failure("HANDOUT_SOURCE_INVALID", "the presentation HTML contains no slides");
  const chapters = chapterGroups(project, pages);
  const checks = [titleCheck(pages)];
  const components = {};

  // Per-page script Markdown, from the reviewed script; titles come from the rendered slides.
  if (editions.includes("speaker")) {
    if (!scriptReview || !pages.some(page => page.script)) components.script = { status: "unavailable", reason: "no authored speaker_notes to publish" };
    else {
      const markdown = renderHandoutScript(project, pages, scriptReview);
      const entry = await write("script.md", markdown);
      const check = scriptTitleCheck(markdown, pages);
      checks.push(check);
      components.script = { status: "generated", file: entry.name, sha256: entry.sha256, script_revision: scriptReview.script_revision, source: scriptSource ?? "generated:speaker-script-review", title_check: check.status };
    }
  }

  const browser = options.browserPath ?? await (options.findBrowser ?? findBrowser)();
  const canRender = Boolean(browser || options.printPdf);
  const unavailable = browserComponents(undefined).pdf;
  const printPdf = options.printPdf ?? printHtmlPdf;
  const capture = options.capturePreviews ?? captureSlidePreviews;

  // Vector PDF printed by Chromium from the reviewed HTML; text remains real text, never a screenshot.
  const printEdition = async (relative, omitPages, id) => {
    if (!canRender) return { ...unavailable };
    try {
      const bytes = await printPdf({ htmlFile, browserPath: browser, presentation: true, omitPages });
      if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("EXPORT_FAILED", "PDF exporter returned invalid data");
      const entry = await write(relative, bytes);
      const check = await inspectPdfPageConsistency({ htmlFile, pdfBytes: bytes, omitPages, id });
      checks.push(check);
      return { status: "generated", exporter: "chromium-print", file: entry.name, sha256: entry.sha256, page_count: check.page_count, text_layer: check.text_layer, page_check: check.status };
    } catch (error) { return { status: "failed", code: error.code ?? "EXPORT_FAILED", reason: error.message }; }
  };

  let previews = [];
  if (canRender || options.capturePreviews) {
    try { previews = await capture({ htmlFile, browserPath: browser }); components.previews = { status: "generated", exporter: "chromium-screenshot" }; }
    catch (error) { components.previews = { status: "failed", code: error.code ?? "EXPORT_FAILED", reason: error.message }; }
  } else components.previews = { ...unavailable };
  if (previews.length && previews.length !== pages.length) {
    components.previews = { status: "failed", code: "PREVIEW_COUNT_MISMATCH", reason: `captured ${previews.length} previews for ${pages.length} slides` };
    previews = [];
  }
  const width = Math.max(2, String(Math.max(...pages.map(({ page }) => page))).length);
  const previewName = page => `previews/${String(page).padStart(width, "0")}.png`;
  for (const [index, preview] of previews.entries()) {
    const entry = await write(previewName(pages[index].page), preview.png);
    pages[index].preview = { file: entry.name, sha256: entry.sha256 };
  }
  if (components.previews.status === "generated") components.previews.count = previews.length;

  if (editions.includes("speaker")) {
    components.pdf = await printEdition("slides.pdf", [], "handout-pdf-page-consistency");
    const entry = await write("index.html", renderIndexHtml({ project, chapters, pages, edition: "speaker", components, previewName }));
    components.index = { status: "generated", file: entry.name, sha256: entry.sha256, offline: true };
  }

  let audience;
  if (editions.includes("audience")) {
    const omitted = pages.filter(page => page.audience.status === "merged");
    const included = pages.filter(page => page.audience.status === "included");
    for (const page of included) if (page.preview) {
      const bytes = previews[pages.indexOf(page)].png;
      await write(path.join("audience", previewName(page.page)), bytes);
    }
    const pdf = await printEdition(path.join("audience", "slides.pdf"), omitted.map(({ page }) => page), "handout-audience-pdf-page-consistency");
    const citations = audienceCitations(citationManifest);
    if (citations.status === "generated") {
      const entry = await write(path.join("audience", "citations.md"), renderCitationsMarkdown(project, citations.entries));
      Object.assign(citations, { file: entry.name, sha256: entry.sha256 });
    }
    const audienceChapters = chapters.map(chapter => ({ ...chapter, pages: chapter.pages.filter(page => page.audience.status === "included") })).filter(chapter => chapter.pages.length);
    const index = await write(path.join("audience", "index.html"), renderIndexHtml({ project, chapters: audienceChapters, pages: included, edition: "audience", components: { pdf, previews: components.previews }, previewName, citations }));
    audience = {
      status: pdf.status === "generated" ? "generated" : "incomplete",
      speaker_notes: "excluded",
      included_pages: included.map(({ page }) => page),
      merged_transitions: omitted.map(({ page, audience: decision }) => ({ page, merged_into: decision.merged_into })),
      pdf, citations: citations.status === "generated" ? { status: citations.status, file: citations.file, sha256: citations.sha256, count: citations.entries.length, citation_manifest_revision: citationManifest.revision, pending: citations.entries.filter(({ status }) => status === "pending").map(({ id }) => id) } : citations,
      index: { status: "generated", file: index.name, sha256: index.sha256, offline: true }
    };
  }

  const requested = [...(editions.includes("speaker") ? [components.pdf, components.script, components.previews] : [components.previews]), ...(audience ? [audience.pdf] : [])];
  const summary = {
    schema_version: "1.0",
    kind: "handout",
    editions,
    status: requested.every(item => item?.status === "generated") && checks.every(check => check.status === "passed") ? "complete" : "incomplete",
    source: { ...source, html_file: source.html_file ?? htmlFile, html_sha256: sha256(htmlBytes), script_revision: scriptReview?.script_revision ?? null, script_source: scriptSource ?? null, ...(citationManifest ? { citation_manifest_revision: citationManifest.revision } : {}) },
    chapters: chapters.map(({ id, title, pages: members }) => ({ id, title, pages: members.map(({ page }) => page) })),
    pages: pages.map(({ page, id, title, page_spec_sha256, script_role, merged_into, chapter, preview, audience: decision }) => ({ page, id, title, page_spec_sha256, script_role, ...(merged_into ? { merged_into } : {}), chapter, preview: preview?.file ?? null, preview_sha256: preview?.sha256 ?? null, audience: decision })),
    components: editions.includes("speaker") ? components : { previews: components.previews },
    ...(audience ? { audience } : {}),
    checks: checks.map(({ id, status, required, page_count, text_layer, findings }) => ({ id, status, required, ...(page_count ? { page_count } : {}), ...(text_layer ? { text_layer } : {}), findings })),
    duration_source: "estimated",
    rehearsed_timing: "not_claimed"
  };
  const manifestText = `${JSON.stringify(summary, null, 2)}\n`;
  await write(HANDOUT_MANIFEST, manifestText);
  return { summary, files };
}

/** Reads the newest saved script review for this exact script revision, or reviews the project now. */
export async function loadScriptReview(project, outputsDirectory, reviewSpeakerScript) {
  let review = reviewSpeakerScript(project, { includeScript: true, force: true });
  let source = "generated:speaker-script-review";
  try {
    const saved = JSON.parse(await fs.readFile(path.join(outputsDirectory, "script-review.json"), "utf8"));
    if (saved?.kind === "speaker_script_review" && saved.script_revision === review.script_revision && saved.project === review.project) { review = saved; source = "outputs/script-review.json"; }
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  return { review, source };
}

function handoutPages(project, htmlPages, scriptReview) {
  const specs = new Map((project.pages ?? []).map(page => [page.page, page]));
  const reviewed = new Map((scriptReview?.pages ?? []).map(page => [page.page, page]));
  const pages = htmlPages.map(({ page, fields }) => {
    const spec = specs.get(page);
    const review = reviewed.get(page);
    return {
      page,
      id: spec?.id ?? null,
      title: fields.title[0] ?? "",
      spec_title: spec?.screen_text?.title ?? null,
      page_spec_sha256: spec ? digest(spec) : null,
      script_role: review?.script_role ?? spec?.script_role ?? (spec ? "core" : "reference"),
      ...(review?.merged_into ? { merged_into: review.merged_into } : {}),
      ...(review?.merged_with ? { merged_with: review.merged_with } : {}),
      words: review?.words ?? 0,
      target_words: review?.target_words,
      estimated_seconds: review?.estimated_seconds,
      script: typeof review?.script === "string" ? review.script : "",
      generated: !spec
    };
  });
  // Audience edition: transition pages fold into their declared host, else into the next kept page.
  // Title-only boundary pages are never removed.
  pages.forEach((page, index) => {
    const boundary = index === 0 || index === pages.length - 1;
    if (page.script_role !== "transition" || boundary) { page.audience = { status: "included" }; return; }
    const next = pages.slice(index + 1).find(candidate => candidate.script_role !== "transition");
    page.audience = { status: "merged", merged_into: page.merged_into ?? next?.page ?? null };
  });
  return pages;
}

function chapterGroups(project, pages) {
  const sections = project.contracts?.outline?.sections ?? [];
  const sectionOf = new Map(sections.flatMap(section => section.page_ids.map(id => [id, section])));
  const chapters = [];
  let current;
  for (const page of pages) {
    let key, title;
    const section = page.id ? sectionOf.get(page.id) : undefined;
    if (section) { key = section.id; title = section.title; }
    else if (page.generated) { key = "appendix"; title = "参考资料"; }
    else if (!sections.length && page.script_role === "transition") { key = `chapter-${page.page}`; title = page.title; }
    else { key = current?.id ?? "chapter-main"; title = current?.title ?? project.project?.title ?? "全部页面"; }
    if (current?.id !== key) { current = { id: key, title, pages: [] }; chapters.push(current); }
    current.pages.push(page);
    page.chapter = key;
  }
  return chapters;
}

function titleCheck(pages) {
  const findings = pages.filter(page => page.spec_title !== null && normalize(page.spec_title) !== normalize(page.title)).map(page => ({ rule: "slide-title-mismatch", severity: "major", page: page.page, evidence: { html: page.title, page_spec: page.spec_title }, verification: "automated" }));
  return { id: "handout-slide-titles", status: findings.length ? "failed" : "passed", required: true, findings };
}

function scriptTitleCheck(markdown, pages) {
  const headings = [...markdown.matchAll(/^## (\d+)\. (.*)$/gm)].map(match => ({ page: Number(match[1]), title: match[2] }));
  const findings = [];
  if (headings.length !== pages.length) findings.push({ rule: "script-page-count-mismatch", severity: "blocking", page: null, evidence: { script: headings.length, slides: pages.length }, verification: "automated" });
  for (const [index, page] of pages.entries()) {
    const heading = headings[index];
    if (heading && (heading.page !== page.page || normalize(heading.title) !== normalize(markdownText(page.title)))) findings.push({ rule: "script-title-mismatch", severity: "blocking", page: page.page, evidence: { script: heading.title, slide: page.title }, verification: "automated" });
  }
  return { id: "handout-script-titles", status: findings.length ? "failed" : "passed", required: true, findings };
}

function renderHandoutScript(project, pages, review) {
  const lines = [`# ${markdownText(project.project?.title ?? "")} · 逐页讲稿`, "", `> 讲稿来自审校结果（script revision \`${review.script_revision}\`），页标题取自幻灯片。时长为按字数推算的估计值，不代表彩排实测。`, ""];
  for (const page of pages) {
    lines.push(`## ${page.page}. ${markdownText(page.title)}`, "");
    const meta = [`角色：${page.script_role}`, `字数：${page.words}${page.target_words === undefined ? "" : ` / 目标 ${page.target_words}`}`];
    if (page.estimated_seconds !== undefined) meta.push(`估计 ${page.estimated_seconds} 秒`);
    lines.push(`- ${meta.join(" · ")}`);
    if (page.merged_into) lines.push(`- 本页与第 ${page.merged_into} 页连讲，时长计入第 ${page.merged_into} 页`);
    if (page.merged_with?.length) lines.push(`- 连讲页：${page.merged_with.map(item => `第 ${item} 页`).join("、")}`);
    lines.push("", page.script.trim() ? page.script.trim() : "_本页无讲稿。_", "");
  }
  return `${lines.join("\n")}`;
}

function audienceCitations(manifest) {
  if (!manifest) return { status: "not_declared", reason: "the Build has no governed citation manifest" };
  const entries = manifest.citations.filter(entry => entry.disclosure === "public" && entry.channels.some(channel => channel !== "internal_only"));
  if (!entries.length) return { status: "empty", reason: "no public citations are cleared for audience channels" };
  return { status: "generated", entries };
}

function renderCitationsMarkdown(project, entries) {
  return `# ${markdownText(project.project?.title ?? "")} · 参考资料\n\n${entries.map(entry => `- ${markdownText(renderCitation(entry))}${entry.status === "pending" ? "（书目信息待补充）" : ""}`).join("\n")}\n`;
}

function renderIndexHtml({ project, chapters, pages, edition, components, previewName, citations }) {
  const title = project.project?.title ?? "";
  const heading = edition === "audience" ? `${title} · 听众版` : `${title} · 讲后资料`;
  const links = [
    components.pdf?.status === "generated" ? `<a href="slides.pdf">PDF（${components.pdf.page_count?.pdf ?? "?"} 页，可复制文字）</a>` : `<span class="muted">PDF 不可用：${escapeHtml(components.pdf?.reason ?? "未生成")}</span>`,
    ...(edition === "speaker" ? [components.script?.status === "generated" ? `<a href="script.md">逐页讲稿（Markdown）</a>` : `<span class="muted">逐页讲稿不可用：${escapeHtml(components.script?.reason ?? "未生成")}</span>`] : []),
    ...(citations?.status === "generated" ? [`<a href="citations.md">参考资料（${citations.entries.length} 条）</a>`] : [])
  ];
  const card = page => `<figure>${page.preview ? `<img src="${previewName(page.page)}" alt="第 ${page.page} 页：${escapeHtml(page.title)}" loading="lazy" width="960" height="540">` : `<div class="placeholder">预览不可用</div>`}<figcaption><b>${page.page}</b> ${escapeHtml(page.title)}</figcaption></figure>`;
  const sections = chapters.map(chapter => `<section><h2>${escapeHtml(chapter.title)}</h2><div class="grid">${chapter.pages.map(card).join("")}</div></section>`).join("");
  const appendix = citations?.status === "generated" ? `<section><h2>参考资料</h2><ol class="refs">${citations.entries.map(entry => `<li>${escapeHtml(renderCitation(entry))}${entry.status === "pending" ? "（书目信息待补充）" : ""}</li>`).join("")}</ol></section>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>
:root{--bg:#f7f6f2;--fg:#1d1d1f;--muted:#6b6b70;--card:#ffffff;--line:#d9d7d0;--accent:#c4512f}
@media (prefers-color-scheme: dark){:root{--bg:#161618;--fg:#ececee;--muted:#a1a1a6;--card:#232326;--line:#38383c;--accent:#f08a63}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
nav{display:flex;flex-wrap:wrap;gap:12px 20px;margin:8px 0 0}a{color:var(--accent)}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
img,.placeholder{display:block;width:100%;height:auto;aspect-ratio:16/9}.placeholder{display:flex;align-items:center;justify-content:center;color:var(--muted)}figcaption{padding:8px 12px;font-size:14px}figcaption b{color:var(--accent);margin-right:6px}
.refs{padding-left:24px;word-break:break-word}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p class="muted">共 ${pages.length} 页，按章节分组。本页及其引用的文件均为本地文件，可离线打开。</p>
<nav>${links.join("")}</nav>
${sections}
${appendix}
</main>
</body>
</html>
`;
}

function markdownText(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function normalize(value) { return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim(); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }

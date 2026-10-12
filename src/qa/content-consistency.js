import crypto from "node:crypto";
import fs from "node:fs/promises";
import zlib from "node:zlib";
import JSZip from "jszip";

/**
 * Compare the semantic text present in the actual HTML and PPTX artifacts.
 * This is intentionally not a pixel or layout comparison.
 */
export async function inspectContentConsistency({ htmlFile, pptxFile, buildRevision = null }) {
  const [htmlBytes, pptxBytes] = await Promise.all([fs.readFile(htmlFile), fs.readFile(pptxFile)]);
  const [htmlPages, pptxPages] = await Promise.all([
    extractHtmlPages(htmlBytes.toString("utf8")),
    extractPptxPages(pptxBytes)
  ]);
  const artifactHashes = {
    html: sha256(htmlBytes),
    pptx: sha256(pptxBytes)
  };
  const pageCount = Math.max(htmlPages.length, pptxPages.length);
  const pages = [];
  const findings = [];
  for (let index = 0; index < pageCount; index += 1) {
    const html = htmlPages[index];
    const pptx = pptxPages[index];
    const pageFindings = [];
    if (!html || !pptx) {
      pageFindings.push(finding("page-missing", "blocking", {
        html_page: html?.page ?? null,
        pptx_page: pptx?.page ?? null
      }));
    } else {
      const htmlTitle = normalizeList(html.fields.title);
      const pptxTitle = normalizeList(pptx.fields.title);
      if (htmlTitle.join("\n") !== pptxTitle.join("\n")) {
        pageFindings.push(finding("field-mismatch", "blocking", { field: "title", html: html.fields.title, pptx: pptx.fields.title, normalized_html: htmlTitle, normalized_pptx: pptxTitle }));
      }
      // HTML adds presentation chrome (slide number, task/visual-job footer) and may show the
      // three-second message beside the body copy, while native PPTX renders the body (or the
      // subtitle/message when there is no body). Compare what both renderers promise to carry:
      // the primary copy must reach PPTX, and PPTX must not invent text the HTML page lacks.
      const htmlText = normalizeText(html.text);
      const pptxText = normalizeText(pptx.text);
      const expected = normalizeList(html.fields.body.length ? html.fields.body : html.fields.subtitle.length ? html.fields.subtitle : html.fields.message_only);
      const missing = expected.filter(value => !pptxText.includes(value));
      if (missing.length) {
        pageFindings.push(finding("field-mismatch", "blocking", { field: "message", html: expected, pptx: pptx.fields.content, missing_in_pptx: missing }));
      }
      const extra = normalizeList(pptx.fields.content).filter(value => !htmlText.includes(value));
      if (extra.length) pageFindings.push(finding("pptx-extra-content", "major", { pptx: extra }));
      const htmlNumbers = extractSensitiveTokens(html.text);
      const pptxNumbers = extractSensitiveTokens(pptx.text);
      const expectedNumbers = extractSensitiveTokens([...html.fields.title, ...expected].join(" "));
      if (pptxNumbers.some(token => !htmlNumbers.includes(token)) || expectedNumbers.some(token => !pptxNumbers.includes(token))) {
        pageFindings.push(finding("sensitive-token-mismatch", "blocking", {
          html: htmlNumbers, pptx: pptxNumbers
        }));
      }
    }
    pages.push({ page: index + 1, html_page: html?.page ?? null, pptx_page: pptx?.page ?? null, status: pageFindings.length ? "failed" : "passed", findings: pageFindings });
    findings.push(...pageFindings.map(item => ({ ...item, page: index + 1 })));
  }
  const status = findings.some(({ severity }) => severity === "blocking" || severity === "major") ? "failed" : "passed";
  return {
    id: "html-pptx-content-consistency",
    kind: "automated",
    status,
    required: true,
    scope: "semantic-content-only",
    build_revision: buildRevision,
    artifacts: { html_file: htmlFile, pptx_file: pptxFile, ...artifactHashes },
    page_count: { html: htmlPages.length, pptx: pptxPages.length },
    pages,
    findings,
    limitations: [
      "Does not compare pixels, geometry, animation, fonts, or visual hierarchy.",
      "Speaker notes and hidden PowerPoint content are reported as not checked unless a dedicated notes extractor is added.",
      "Charts, tables, citations, and non-text media are not inferred from rendered pixels; unsupported semantic content requires human review."
    ],
    checked_at: new Date().toISOString()
  };
}

/**
 * Page-count consistency between a generated presentation HTML file and a PDF derived from it.
 * Uses the same slide extraction as the HTML/PPTX check, so both checks agree on what a "page" is.
 * `omitPages` lists HTML data-page values deliberately left out of the PDF (e.g. merged transitions).
 */
export async function inspectPdfPageConsistency({ htmlFile, pdfBytes, omitPages = [], id = "html-pdf-page-consistency" }) {
  const htmlBytes = await fs.readFile(htmlFile);
  const htmlPages = extractHtmlPages(htmlBytes.toString("utf8"));
  const omitted = new Set(omitPages.map(Number));
  const expected = htmlPages.filter(({ page }) => !omitted.has(page)).length;
  const pdf = countPdfPages(pdfBytes);
  const textLayer = pdfTextLayer(pdfBytes);
  const findings = [];
  if (pdf !== expected) findings.push({ ...finding("page-count-mismatch", "blocking", { html: htmlPages.length, omitted: [...omitted].sort((a, b) => a - b), expected, pdf }), page: null });
  if (textLayer !== "present") findings.push({ ...finding("pdf-text-layer-missing", "major", { text_layer: textLayer }), page: null });
  return {
    id,
    kind: "automated",
    status: findings.length ? "failed" : "passed",
    required: true,
    scope: "page-count-and-text-layer",
    artifacts: { html_file: htmlFile, html: sha256(htmlBytes), pdf: sha256(pdfBytes) },
    page_count: { html: htmlPages.length, omitted: omitted.size, expected, pdf },
    text_layer: textLayer,
    findings,
    limitations: [
      "Counts PDF page objects and checks for embedded fonts and text-showing operators; it does not extract or compare the PDF text itself.",
      "Does not compare pixels, geometry or fonts between HTML and PDF."
    ],
    checked_at: new Date().toISOString()
  };
}

export function countPdfPages(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const objects = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  if (objects) return objects;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map(match => Number(match[1]));
  return counts.length ? Math.max(...counts) : 0;
}

// A PDF "has a text layer" when it embeds fonts and at least one content stream shows text (BT ... Tf ... ET).
// Rasterised pages (images only) fail this check, so a screenshot-only PDF cannot pass as selectable text.
export function pdfTextLayer(bytes) {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("latin1");
  if (!/\/Font\b/.test(text)) return "absent";
  const pattern = /(?<!end)stream\r?\n/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    const raw = buffer.subarray(start, end);
    let content;
    try { content = zlib.inflateSync(raw).toString("latin1"); } catch { content = raw.toString("latin1"); }
    if (/\bBT\b[\s\S]*?\bTf\b[\s\S]*?\bET\b/.test(content)) return "present";
    pattern.lastIndex = end + "endstream".length;
  }
  return "absent";
}

async function extractPptxPages(bytes) {
  const archive = await JSZip.loadAsync(bytes);
  const entries = Object.keys(archive.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  return Promise.all(entries.map(async (entry, index) => {
    const xml = await archive.file(entry).async("string");
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1]).trim()).filter(Boolean);
    const meaningful = texts.filter(text => text !== String(index + 1));
    const title = meaningful[0] ?? "";
    return {
      page: index + 1,
      text: meaningful.join(" "),
      fields: {
        title: title ? [title] : [],
        content: meaningful.slice(1)
      }
    };
  }));
}

export function extractHtmlPages(html) {
  return [...html.matchAll(/<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*data-page="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi)].map((match, index) => {
    const source = match[2];
    const field = key => [...source.matchAll(new RegExp(`<[^>]*data-reading-key="${key}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "gi"))].map(item => decodeHtml(stripTags(item[1]))).filter(Boolean);
    const message = [...field("subtitle"), ...field("message"), ...field("body")];
    const footer = source.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i)?.[1] ?? "";
    const footerFields = [...footer.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(item => decodeHtml(stripTags(item[1]))).filter(Boolean);
    const fields = {
      title: field("title"), message, message_only: field("message"), subtitle: field("subtitle"), body: field("body"),
      task: footerFields.slice(0, 1), visual_job: footerFields.slice(1, 2)
    };
    const text = decodeHtml(stripTags(source.replace(/<span\b[^>]*class="slide-number"[^>]*>[\s\S]*?<\/span>/gi, " "))).replace(/\s+/g, " ").trim();
    return { page: Number(match[1]) || index + 1, text, fields };
  });
}

function normalizeList(values) { return values.map(value => normalizeText(value)).filter(Boolean); }

function normalizeText(value) {
  return String(value).normalize("NFKC").replace(/[\u00a0\s]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

function extractSensitiveTokens(text) {
  const normalized = normalizeText(text);
  return [...new Set(normalized.match(/(?:\d+(?:\.\d+)?%?|\d{4}[./年-]\d{1,2}(?:[./月-]\d{1,2})?|[<>≤≥]=?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:人|页|天|次|元|万|个|小时|分钟|秒|倍|件|项|岁|℃|公里|km|kg|MB|GB))/gi) ?? [])].sort();
}

function finding(rule, severity, evidence) { return { rule, severity, evidence, verification: "automated" }; }

function stripTags(value) { return String(value).replace(/<[^>]+>/g, " "); }

function decodeHtml(value) { return decodeXml(String(value).replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&nbsp;/gi, " ")); }

function decodeXml(value) { return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

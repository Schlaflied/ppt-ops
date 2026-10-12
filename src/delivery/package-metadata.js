import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { resolveProjectPath } from "../core/project.js";

/** Inspect share-visible and embedded metadata; never rewrites source artifacts. */
export async function inspectPackageMetadata(projectRoot, manifest) {
  const artifacts = [];
  const findings = [];
  for (const file of manifest.files ?? []) {
    const absolute = resolveProjectPath(projectRoot, file.packaged);
    const extension = path.extname(file.packaged).toLowerCase();
    let metadata = {};
    if ([".pptx", ".docx"].includes(extension)) metadata = await inspectOpenXml(absolute, extension);
    else if (extension === ".pdf") metadata = await inspectPdf(absolute);
    artifacts.push({ id: file.id, role: file.role, extension, metadata });
    for (const field of ["creator", "last_modified_by", "title", "subject", "keywords"]) if (metadata[field]) findings.push({ artifact_id: file.id, check: "embedded-metadata-present", severity: "review", field, value: metadata[field] });
    if (metadata.page_count !== undefined && metadata.page_count < 1) findings.push({ artifact_id: file.id, check: "invalid-visible-page-count", severity: "error", value: metadata.page_count });
  }
  return { status: findings.some(({ severity }) => severity === "error") ? "blocked" : findings.length ? "review" : "passed", artifacts, findings, source_files_modified: false };
}

async function inspectOpenXml(file, extension) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const core = await readXml(zip, "docProps/core.xml");
  const app = await readXml(zip, "docProps/app.xml");
  return compact({
    creator: tag(core, "dc:creator"), last_modified_by: tag(core, "cp:lastModifiedBy"), title: tag(core, "dc:title"),
    subject: tag(core, "dc:subject"), keywords: tag(core, "cp:keywords"), application: tag(app, "Application"),
    page_count: numberTag(app, extension === ".pptx" ? "Slides" : "Pages")
  });
}

async function inspectPdf(file) {
  const text = (await fs.readFile(file)).toString("latin1");
  return compact({ creator: pdfValue(text, "Author"), title: pdfValue(text, "Title"), subject: pdfValue(text, "Subject"), application: pdfValue(text, "Creator"), page_count: Number(text.match(/\/Type\s*\/Page\b/g)?.length ?? 0) });
}

async function readXml(zip, name) { const entry = zip.file(name); return entry ? entry.async("string") : ""; }
function tag(xml, name) { return decode(xml.match(new RegExp(`<${escape(name)}[^>]*>([\\s\\S]*?)<\\/${escape(name)}>`))?.[1]); }
function numberTag(xml, name) { const value = Number(tag(xml, name)); return Number.isFinite(value) ? value : undefined; }
function pdfValue(text, name) { return text.match(new RegExp(`\\/${name}\\s*\\(([^)]*)\\)`))?.[1]?.trim(); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function decode(value) { return value?.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&").trim() || undefined; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")); }

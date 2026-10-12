import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { inspectPackageMetadata } from "../src/delivery/package-metadata.js";

test("inspects PPTX, DOCX and PDF properties without rewriting artifacts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-metadata-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [id, extension, countTag] of [["deck", "pptx", "Slides"], ["guide", "docx", "Pages"]]) {
    const zip = new JSZip();
    zip.file("docProps/core.xml", `<cp:coreProperties><dc:creator>Generator</dc:creator><dc:title>Course</dc:title></cp:coreProperties>`);
    zip.file("docProps/app.xml", `<Properties><Application>PPT-Ops</Application><${countTag}>3</${countTag}></Properties>`);
    const relative = `${id}.${extension}`; await fs.writeFile(path.join(root, relative), await zip.generateAsync({ type: "nodebuffer" }));
    files.push({ id, role: id === "deck" ? "presentation" : "learner_guide", packaged: relative });
  }
  await fs.writeFile(path.join(root, "preview.pdf"), "%PDF-1.4 /Title (Preview) /Author (Generator) /Type /Page /Type /Page");
  files.push({ id: "preview", role: "preview", packaged: "preview.pdf" });
  const result = await inspectPackageMetadata(root, { files });
  assert.equal(result.status, "review");
  assert.equal(result.source_files_modified, false);
  assert.deepEqual(result.artifacts.map(({ metadata }) => metadata.page_count), [3, 3, 2]);
  assert.ok(result.findings.some(({ artifact_id, field }) => artifact_id === "deck" && field === "creator"));
});

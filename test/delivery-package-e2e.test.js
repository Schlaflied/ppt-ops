import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createDeliveryPackage } from "../src/delivery/package.js";
import { inspectPackageMetadata } from "../src/delivery/package-metadata.js";
import { inspectPackageRelations } from "../src/delivery/package-relations.js";
import { evaluateDeliveryPackageAcceptance, renderDeliveryPackageSummary, writeDeliveryPackageSummary } from "../src/delivery/package-acceptance.js";

test("PPTX plus two DOCX files and an alignment report produce a reviewable package", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-package-e2e-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, countTag] of [["slides.pptx", "Slides"], ["learner-guide.docx", "Pages"], ["assessment.docx", "Pages"]]) {
    const zip = new JSZip(); zip.file("docProps/app.xml", `<Properties><${countTag}>4</${countTag}></Properties>`); await fs.writeFile(path.join(root, name), await zip.generateAsync({ type: "nodebuffer" }));
  }
  await fs.writeFile(path.join(root, "alignment-report.pdf"), "%PDF-1.4 /Type /Page");
  const spec = { schema_version: "1.0", id: "training-release", deliverables: [
    ["deck", "presentation", "slides.pptx"], ["guide", "learner_guide", "learner-guide.docx"], ["assessment", "assessment", "assessment.docx"], ["alignment", "alignment_report", "alignment-report.pdf"]
  ].map(([id, role, file]) => ({ id, role, file, section: "final", required: true })) };
  const packaged = await createDeliveryPackage(root, spec);
  const metadata = await inspectPackageMetadata(root, packaged.manifest);
  const relations = inspectPackageRelations(packaged.manifest, [{ type: "aligns_with", from: "assessment", to: "alignment", locator: "LO-1" }], [{ kind: "reference", artifact_id: "alignment", resolved: true }]);
  const pending = evaluateDeliveryPackageAcceptance({ manifest: packaged.manifest, metadata, relations });
  assert.equal(pending.status, "pending");
  const acceptance = evaluateDeliveryPackageAcceptance({ manifest: packaged.manifest, metadata, relations, human_acceptance: { status: "accepted", reviewer: "instructional-designer" }, external_share_review: { status: "accepted" } });
  assert.equal(acceptance.status, "accepted");
  const summary = renderDeliveryPackageSummary(packaged.manifest, { metadata, relations, acceptance });
  const summaryFile = await writeDeliveryPackageSummary(packaged.package_dir, summary);
  assert.match(await fs.readFile(summaryFile, "utf8"), /learner_guide: learner-guide\.docx/);
  assert.equal((await fs.readdir(path.join(packaged.package_dir, "final"))).length, 4);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeliveryPackage, DeliveryPackageError, evaluateRequiredDeliverables, validateDeliveryPackageSpec } from "../src/delivery/package.js";

const spec = { schema_version: "1.0", id: "course-release", deliverables: [
  { id: "deck", role: "presentation", section: "final", file: "slides.pptx", required: true },
  { id: "guide", role: "learner_guide", section: "final", file: "learner-guide.docx", required: true },
  { id: "old-deck", role: "reference", section: "reference", file: "v1.pptx", required: false }
] };

test("delivery package contract separates roles, sections, and required items", () => {
  assert.equal(validateDeliveryPackageSpec(spec).deliverables.length, 3);
  assert.deepEqual(evaluateRequiredDeliverables(spec, ["deck"]), { status: "blocked", missing_required: [{ id: "guide", role: "learner_guide", file: "learner-guide.docx" }] });
  assert.equal(evaluateRequiredDeliverables(spec, ["deck", "guide"]).status, "ready");
});

test("invalid roles, duplicate ids, and internal evidence in final fail closed", () => {
  assert.throws(() => validateDeliveryPackageSpec({ ...spec, deliverables: [spec.deliverables[0], spec.deliverables[0]] }), DeliveryPackageError);
  assert.throws(() => validateDeliveryPackageSpec({ ...spec, deliverables: [{ id: "logs", role: "internal_evidence", section: "final", file: "log.txt", required: false }] }), { code: "DELIVERY_PACKAGE_INVALID" });
});

test("assembly partitions files, hashes copies, preserves sources, and rejects replacement", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-package-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "slides.pptx"), "deck"); await fs.writeFile(path.join(root, "learner-guide.docx"), "guide"); await fs.writeFile(path.join(root, "v1.pptx"), "old");
  const result = await createDeliveryPackage(root, spec);
  assert.deepEqual(result.manifest.files.map(({ section }) => section), ["final", "final", "reference"]);
  assert.ok(result.manifest.files.every(({ sha256 }) => sha256.length === 64));
  assert.equal(await fs.readFile(path.join(root, "slides.pptx"), "utf8"), "deck");
  await assert.rejects(createDeliveryPackage(root, spec), { code: "DELIVERY_PACKAGE_EXISTS" });
});

test("assembly fails before publishing when required or temporary files are present", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pptops-package-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(createDeliveryPackage(root, spec), { code: "DELIVERY_PACKAGE_REQUIRED_MISSING" });
  const temporary = { ...spec, id: "bad", deliverables: [{ id: "temp", role: "presentation", section: "final", file: "slides.tmp", required: true }] };
  await fs.writeFile(path.join(root, "slides.tmp"), "partial");
  await assert.rejects(createDeliveryPackage(root, temporary), { code: "DELIVERY_PACKAGE_TEMPORARY_FILE" });
});

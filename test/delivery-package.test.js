import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryPackageError, evaluateRequiredDeliverables, validateDeliveryPackageSpec } from "../src/delivery/package.js";

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

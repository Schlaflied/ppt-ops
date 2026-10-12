const ROLES = new Set(["presentation", "learner_guide", "assessment", "alignment_report", "preview", "reference", "source", "internal_evidence"]);
const SECTIONS = new Set(["final", "reference", "source", "internal"]);
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../core/project.js";

export class DeliveryPackageError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

/** Validate a multi-file delivery declaration before any files are copied. */
export function validateDeliveryPackageSpec(spec) {
  if (!spec || spec.schema_version !== "1.0" || !validId(spec.id)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", "package requires schema_version 1.0 and a stable id");
  if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0) throw new DeliveryPackageError("DELIVERY_PACKAGE_EMPTY", "package requires at least one deliverable");
  const ids = new Set();
  for (const [index, item] of spec.deliverables.entries()) {
    if (!validId(item?.id) || ids.has(item.id)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] needs a unique stable id`);
    ids.add(item.id);
    if (!ROLES.has(item.role) || !SECTIONS.has(item.section)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] has an invalid role or section`);
    if (typeof item.file !== "string" || !item.file.trim() || item.file.includes("\0")) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}].file is required`);
    if (typeof item.required !== "boolean") throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}].required must be boolean`);
    if (item.section === "final" && ["reference", "source", "internal_evidence"].includes(item.role)) throw new DeliveryPackageError("DELIVERY_PACKAGE_INVALID", `deliverables[${index}] cannot place ${item.role} in final`);
  }
  return { ...spec, deliverables: spec.deliverables.map((item) => ({ ...item })) };
}

export function evaluateRequiredDeliverables(spec, availableIds) {
  const valid = validateDeliveryPackageSpec(spec);
  const available = new Set(availableIds ?? []);
  const missing = valid.deliverables.filter((item) => item.required && !available.has(item.id)).map(({ id, role, file }) => ({ id, role, file }));
  return { status: missing.length ? "blocked" : "ready", missing_required: missing };
}

/** Assemble an immutable, partitioned package without modifying source files. */
export async function createDeliveryPackage(projectRoot, inputSpec, { outputRoot = ".pptops/delivery-packages" } = {}) {
  const spec = validateDeliveryPackageSpec(inputSpec);
  const packageDir = resolveProjectPath(projectRoot, path.join(outputRoot, spec.id));
  try { await fs.access(packageDir); throw new DeliveryPackageError("DELIVERY_PACKAGE_EXISTS", `package already exists: ${spec.id}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const resolved = [];
  const missing = [];
  for (const item of spec.deliverables) {
    rejectTemporary(item.file);
    const source = resolveProjectPath(projectRoot, item.file);
    let stat;
    try { stat = await fs.lstat(source); } catch (error) { if (error.code === "ENOENT") { if (item.required) missing.push(item); continue; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DeliveryPackageError("DELIVERY_PACKAGE_UNSAFE_SOURCE", `deliverable must be a regular file: ${item.id}`);
    resolved.push({ item, source });
  }
  if (missing.length) throw new DeliveryPackageError("DELIVERY_PACKAGE_REQUIRED_MISSING", "required deliverables are missing", { missing: missing.map(({ id, file }) => ({ id, file })) });
  await fs.mkdir(packageDir, { recursive: true });
  const files = [];
  try {
    for (const { item, source } of resolved) {
      const destination = path.join(packageDir, item.section, path.basename(item.file));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      const bytes = await fs.readFile(destination);
      files.push({ id: item.id, role: item.role, section: item.section, required: item.required, source: item.file, packaged: path.relative(projectRoot, destination), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const manifest = { schema_version: "1.0", kind: "delivery_package", id: spec.id, source_files_preserved: true, files };
    await fs.writeFile(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { package_dir: packageDir, manifest };
  } catch (error) {
    await fs.rm(packageDir, { recursive: true, force: true });
    throw error;
  }
}

function rejectTemporary(file) {
  const name = path.basename(file).toLowerCase();
  if (name.startsWith("~$") || /\.(tmp|temp|bak|part|crdownload)$/.test(name)) throw new DeliveryPackageError("DELIVERY_PACKAGE_TEMPORARY_FILE", `temporary file cannot be delivered: ${file}`);
}

function validId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value); }

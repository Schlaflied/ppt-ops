import fs from "node:fs/promises";
import path from "node:path";

export function evaluateDeliveryPackageAcceptance({ manifest, metadata, relations, human_acceptance, external_share_review }) {
  const findings = [];
  if (!manifest?.files?.length) findings.push("package manifest has no files");
  if (metadata?.status === "blocked") findings.push("artifact metadata inspection is blocked");
  if (relations?.status === "blocked") findings.push("cross-file validation is blocked");
  if (human_acceptance?.status !== "accepted" || !human_acceptance?.reviewer) findings.push("named human delivery acceptance is required");
  if (external_share_review?.status !== "accepted") findings.push("external sharing metadata review is required");
  return { status: findings.length ? "pending" : "accepted", automated_checks_are_human_acceptance: false, findings };
}

export function renderDeliveryPackageSummary(manifest, { metadata, relations, acceptance } = {}) {
  const lines = [`# Delivery package: ${manifest.id}`, "", `Status: ${acceptance?.status ?? "pending"}`, "", "## Final deliverables"];
  for (const file of (manifest.files ?? []).filter(({ section }) => section === "final")) lines.push(`- ${file.role}: ${path.basename(file.packaged)} (${file.sha256.slice(0, 12)}…)`);
  lines.push("", "## Reference and source files");
  const supporting = (manifest.files ?? []).filter(({ section }) => section !== "final");
  if (!supporting.length) lines.push("- None"); else for (const file of supporting) lines.push(`- ${file.section}/${file.role}: ${path.basename(file.packaged)}`);
  lines.push("", "## Checks", `- Metadata: ${metadata?.status ?? "not-run"}`, `- Cross-file relations: ${relations?.status ?? "not-run"}`, `- Human acceptance: ${acceptance?.status ?? "pending"}`);
  return `${lines.join("\n")}\n`;
}

export async function writeDeliveryPackageSummary(packageDir, summary) {
  const file = path.join(packageDir, "DELIVERY.md");
  await fs.writeFile(file, summary, { flag: "wx" });
  return file;
}

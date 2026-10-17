import { access, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import type { PipelinePlan, ValidationItem, ValidationReport } from "../types.js";
import { ensureDirectory, sha256File, writeJson } from "./io.js";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const normalizeImages = async (
  plan: PipelinePlan,
  rawDirectory: string,
  candidateDirectory: string,
): Promise<void> => {
  await ensureDirectory(candidateDirectory);
  for (const job of plan.jobs) {
    const source = path.join(rawDirectory, job.fileName);
    if (!(await exists(source))) continue;
    const output = path.join(candidateDirectory, job.fileName);
    if (job.output.preserveFraming) {
      const metadata = await sharp(source).metadata();
      const sourceRatio = (metadata.width ?? 0) / (metadata.height ?? 1);
      const targetRatio = job.output.width / job.output.height;
      if (Math.abs(sourceRatio / targetRatio - 1) > 0.005) {
        throw new Error(`Framing mismatch for ${job.id}: ${metadata.width}x${metadata.height}; refusing crop, padding, or stretch`);
      }
    }
    const pipeline = sharp(source).resize(job.output.width, job.output.height, {
      fit: job.output.preserveFraming ? "fill" : job.output.fit,
      position: "centre",
      background: { r: 12, g: 14, b: 18, alpha: 1 },
    });
    if (job.output.format === "jpeg") await pipeline.jpeg({ quality: 92 }).toFile(output);
    else if (job.output.format === "webp") await pipeline.webp({ quality: 92 }).toFile(output);
    else await pipeline.png({ compressionLevel: 9 }).toFile(output);
  }
};

export const validateImages = async (
  plan: PipelinePlan,
  candidateDirectory: string,
  reportPath: string,
): Promise<ValidationReport> => {
  const items: ValidationItem[] = [];
  const hashes = new Map<string, string[]>();
  for (const job of plan.jobs) {
    const filePath = path.join(candidateDirectory, job.fileName);
    const errors: string[] = [];
    if (!(await exists(filePath))) {
      items.push({ id: job.id, fileName: job.fileName, valid: false, errors: ["missing file"] });
      continue;
    }
    let width: number | undefined;
    let height: number | undefined;
    let format: string | undefined;
    try {
      const metadata = await sharp(filePath).metadata();
      width = metadata.width;
      height = metadata.height;
      format = metadata.format;
      if (width !== job.output.width || height !== job.output.height) {
        errors.push(`expected ${job.output.width}x${job.output.height}, received ${width ?? "?"}x${height ?? "?"}`);
      }
      if (format !== job.output.format) errors.push(`expected ${job.output.format}, received ${format ?? "unknown"}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unreadable image");
    }
    const hash = await sha256File(filePath);
    hashes.set(hash, [...(hashes.get(hash) ?? []), job.id]);
    items.push({ id: job.id, fileName: job.fileName, sha256: hash, width, height, format, valid: errors.length === 0, errors });
  }
  const duplicateGroups = [...hashes.values()].filter((ids) => ids.length > 1);
  for (const group of duplicateGroups) {
    for (const id of group) {
      const item = items.find((candidate) => candidate.id === id);
      if (item) {
        item.valid = false;
        item.errors.push(`duplicate image shared by: ${group.join(", ")}`);
      }
    }
  }
  const report: ValidationReport = {
    version: 1,
    planHash: plan.planHash,
    valid: items.every((item) => item.valid),
    items,
    duplicateGroups,
  };
  await writeJson(reportPath, report);
  return report;
};

const escapeXml = (value: string): string =>
  value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character] ?? character);

export const createContactSheet = async (
  plan: PipelinePlan,
  candidateDirectory: string,
  outputPath: string,
): Promise<void> => {
  const columns = plan.jobs.length >= 8
    ? 4
    : Math.min(3, Math.max(1, plan.jobs.length));
  const tileWidth = 480;
  const tileHeight = 300;
  const labelHeight = 48;
  const rows = Math.ceil(plan.jobs.length / columns);
  const canvas = sharp({
    create: {
      width: columns * tileWidth,
      height: rows * (tileHeight + labelHeight),
      channels: 3,
      background: "#0e1117",
    },
  });
  const composites: OverlayOptions[] = [];
  for (let index = 0; index < plan.jobs.length; index += 1) {
    const job = plan.jobs[index];
    if (!job) continue;
    const filePath = path.join(candidateDirectory, job.fileName);
    if (!(await exists(filePath))) continue;
    const left = (index % columns) * tileWidth;
    const top = Math.floor(index / columns) * (tileHeight + labelHeight);
    const image = await sharp(await readFile(filePath))
      .resize(tileWidth, tileHeight, { fit: "contain", background: "#0e1117" })
      .toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#171b23"/><text x="16" y="31" fill="#f7f8fa" font-family="Arial, sans-serif" font-size="20" font-weight="600">${escapeXml(job.id)}</text></svg>`);
    composites.push({ input: image, left, top });
    composites.push({ input: label, left, top: top + tileHeight });
  }
  await ensureDirectory(path.dirname(outputPath));
  await canvas.composite(composites).png().toFile(outputPath);
};

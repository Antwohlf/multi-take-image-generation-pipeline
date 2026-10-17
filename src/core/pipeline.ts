import { access, rm } from "node:fs/promises";
import path from "node:path";
import { getAdapter } from "../adapters/index.js";
import type { PipelinePlan, PipelineRunReport, ProviderName } from "../types.js";
import { ensureApprovalFile, writeReleaseManifest } from "./approvals.js";
import { createContactSheet, normalizeImages, validateImages } from "./images.js";
import { ensureDirectory, readJson, relativeDisplayPath, sleep, writeJson } from "./io.js";
import { loadManifestAndPlan } from "./plan.js";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export interface RunOptions {
  manifestPath: string;
  workDirectory: string;
  provider?: ProviderName;
  confirmCost?: boolean;
}

export const runPipeline = async (options: RunOptions): Promise<PipelineRunReport> => {
  const root = path.resolve(options.workDirectory);
  const rawDirectory = path.join(root, "raw");
  const candidateDirectory = path.join(root, "candidates");
  const requestDirectory = path.join(root, "requests");
  const inboxDirectory = path.join(root, "inbox");
  const planPath = path.join(root, "plan.json");
  const approvalsPath = path.join(root, "approvals.json");
  const validationPath = path.join(root, "validation.json");
  const contactSheetPath = path.join(root, "contact-sheet.png");
  const releaseManifestPath = path.join(root, "release-manifest.json");
  await Promise.all([
    ensureDirectory(rawDirectory),
    ensureDirectory(candidateDirectory),
    ensureDirectory(requestDirectory),
    ensureDirectory(inboxDirectory),
  ]);

  // A prior success must never survive a failed or incomplete rerun.
  await rm(releaseManifestPath, { force: true });
  const { plan, manifestDirectory } = await loadManifestAndPlan(options.manifestPath);
  const provider = options.provider ?? plan.generation.provider;
  const adapter = getAdapter(provider);
  if (await exists(planPath)) {
    const previous = await readJson<PipelinePlan>(planPath);
    if (previous.planHash !== plan.planHash) {
      throw new Error("Work directory belongs to a different plan or reference bytes; use a new work directory");
    }
  }
  await writeJson(planPath, plan);
  const counts = {
    total: plan.jobs.length,
    generated: 0,
    imported: 0,
    skipped: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
  };

  for (const job of plan.jobs) {
    const destination = path.join(rawDirectory, job.fileName);
    if (await exists(destination)) {
      counts.skipped += 1;
      continue;
    }
    const result = await adapter.generate({
      job,
      plan,
      manifestDirectory,
      destination,
      requestDirectory,
      inboxDirectory,
      confirmCost: options.confirmCost ?? false,
    });
    counts[result.status] += 1;
    if (plan.generation.delayMs > 0 && result.status === "generated" && provider === "openai") {
      await sleep(plan.generation.delayMs);
    }
  }

  const approvals = await ensureApprovalFile(plan, approvalsPath);
  counts.approved = Object.values(approvals.decisions).filter((decision) => decision.status === "approved").length;
  counts.rejected = Object.values(approvals.decisions).filter((decision) => decision.status === "rejected").length;

  const reportBase = {
    version: 1 as const,
    planHash: plan.planHash,
    provider,
    counts,
    files: {
      plan: relativeDisplayPath(root, planPath),
      approvals: relativeDisplayPath(root, approvalsPath),
    },
  };

  if (counts.pending > 0) {
    const report: PipelineRunReport = { ...reportBase, status: "awaiting_generation" };
    await writeJson(path.join(root, "run-report.json"), report);
    return report;
  }

  await normalizeImages(plan, rawDirectory, candidateDirectory);
  const validation = await validateImages(plan, candidateDirectory, validationPath);
  for (const job of plan.jobs) {
    const decision = approvals.decisions[job.id];
    const item = validation.items.find(item => item.id === job.id);
    if (decision?.status === "approved" && (!item?.valid || !decision.candidateSha256 || decision.candidateSha256 !== item.sha256)) {
      approvals.decisions[job.id] = { status: "pending", note: "Candidate changed or failed validation; review these exact bytes again." };
    }
  }
  await writeJson(approvalsPath, approvals);
  counts.approved = Object.values(approvals.decisions).filter(decision => decision.status === "approved").length;
  if (!validation.valid) {
    const report: PipelineRunReport = {
      ...reportBase,
      status: "failed",
      files: { ...reportBase.files, validation: relativeDisplayPath(root, validationPath) },
    };
    await writeJson(path.join(root, "run-report.json"), report);
    return report;
  }

  await createContactSheet(plan, candidateDirectory, contactSheetPath);
  const released = await writeReleaseManifest(
    plan,
    approvals,
    validation,
    relativeDisplayPath(root, candidateDirectory),
    releaseManifestPath,
  );
  const report: PipelineRunReport = {
    ...reportBase,
    status: released ? "complete" : "awaiting_approval",
    files: {
      ...reportBase.files,
      validation: relativeDisplayPath(root, validationPath),
      contactSheet: relativeDisplayPath(root, contactSheetPath),
      ...(released ? { releaseManifest: relativeDisplayPath(root, releaseManifestPath) } : {}),
    },
  };
  await writeJson(path.join(root, "run-report.json"), report);
  return report;
};

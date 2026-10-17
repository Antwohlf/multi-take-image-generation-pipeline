import { access, rm } from "node:fs/promises";
import path from "node:path";
import type { ApprovalFile, PipelinePlan, ValidationReport } from "../types.js";
import { readJson, sha256File, writeJson } from "./io.js";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const ensureApprovalFile = async (
  plan: PipelinePlan,
  filePath: string,
): Promise<ApprovalFile> => {
  if (await exists(filePath)) {
    const existing = await readJson<ApprovalFile>(filePath);
    if (existing.planHash !== plan.planHash) {
      throw new Error("Approval file belongs to a different plan");
    }
    return existing;
  }
  const approvals: ApprovalFile = {
    version: 1,
    planHash: plan.planHash,
    decisions: Object.fromEntries(plan.jobs.map((job) => [job.id, { status: "pending" }])),
  };
  await writeJson(filePath, approvals);
  return approvals;
};

export const approveAll = async (filePath: string, expectedPlanHash?: string): Promise<void> => {
  const approvals = await readJson<ApprovalFile>(filePath);
  if (expectedPlanHash && approvals.planHash !== expectedPlanHash) {
    throw new Error("Approval file belongs to a different plan");
  }
  const root = path.dirname(filePath);
  const plan = await readJson<PipelinePlan>(path.join(root, "plan.json"));
  if (plan.planHash !== approvals.planHash) throw new Error("Approval file belongs to a different plan");
  const validation = await readJson<ValidationReport>(path.join(root, "validation.json"));
  if (!validation.valid || validation.planHash !== approvals.planHash) {
    throw new Error("Approval requires successful validation of the same plan");
  }
  const decidedAt = new Date().toISOString();
  for (const { id } of plan.jobs) {
    const item = validation.items.find(item => item.id === id);
    if (!item?.sha256 || !item.valid || await sha256File(path.join(root, "candidates", item.fileName)) !== item.sha256) {
      throw new Error(`Candidate changed or has not passed validation: ${id}`);
    }
    approvals.decisions[id] = { status: "approved", decidedAt, candidateSha256: item.sha256 };
  }
  await writeJson(filePath, approvals);
};

export const writeReleaseManifest = async (
  plan: PipelinePlan,
  approvals: ApprovalFile,
  validation: ValidationReport,
  candidateDirectory: string,
  outputPath: string,
): Promise<boolean> => {
  await rm(outputPath, { force: true });
  if (approvals.planHash !== plan.planHash || validation.planHash !== plan.planHash || !validation.valid) return false;
  const verifiedIds = new Set<string>();
  for (const job of plan.jobs) {
    const decision = approvals.decisions[job.id];
    const item = validation.items.find(item => item.id === job.id);
    if (decision?.status !== "approved" || !item?.valid || !item.sha256 || decision.candidateSha256 !== item.sha256) continue;
    const candidate = path.resolve(path.dirname(outputPath), candidateDirectory, job.fileName);
    if (!(await exists(candidate)) || await sha256File(candidate) !== item.sha256) continue;
    verifiedIds.add(job.id);
  }
  const approvedJobs = plan.jobs.filter(job => verifiedIds.has(job.id));
  if (!approvedJobs.length || (plan.approval.requireAll && approvedJobs.length !== plan.jobs.length)) return false;

  await writeJson(outputPath, {
    version: 1,
    name: plan.name,
    planHash: plan.planHash,
    assets: approvedJobs.map((job) => {
      const validationItem = validation.items.find((item) => item.id === job.id);
      return {
        id: job.id,
        fileName: job.fileName,
        path: path.join(candidateDirectory, job.fileName),
        sha256: validationItem?.sha256,
        promptHash: job.promptHash,
        fingerprint: job.fingerprint,
        variables: job.variables,
        references: job.references,
        referenceHashes: job.referenceHashes,
        approval: approvals.decisions[job.id],
      };
    }),
  });
  return true;
};

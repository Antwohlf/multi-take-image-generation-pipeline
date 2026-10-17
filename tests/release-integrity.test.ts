import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { approveAll } from "../src/core/approvals.js";
import { runPipeline } from "../src/core/pipeline.js";
import { loadManifestAndPlan } from "../src/core/plan.js";

const fixtureManifest = path.resolve("examples/seasonal-scenes/pipeline.json");
const root = () => mkdtemp(path.join(os.tmpdir(), "multitake-integrity-"));
const json = async (p: string) => JSON.parse(await readFile(p, "utf8"));

async function approvedRun() {
  const workDirectory = await root();
  await runPipeline({ manifestPath: fixtureManifest, workDirectory, provider: "fixture" });
  await approveAll(path.join(workDirectory, "approvals.json"));
  expect((await runPipeline({ manifestPath: fixtureManifest, workDirectory, provider: "fixture" })).status).toBe("complete");
  return workDirectory;
}

describe("release integrity", () => {
  it("preserves different scene aspect ratios in one validated family", async () => {
    const workDirectory = await root();
    const manifest = await json(fixtureManifest);
    for (const variant of manifest.variants) variant.references = [];
    manifest.variants[0].output = { width: 640, height: 360, fit: "contain", format: "png", preserveFraming: true };
    const manifestPath = path.join(workDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await runPipeline({ manifestPath, workDirectory, provider: "fixture" });
    expect(report.status).toBe("awaiting_approval");
    const validation = await json(path.join(workDirectory, "validation.json"));
    expect(validation.items.slice(0, 4).every((item: { width: number; height: number }) => item.width === 640 && item.height === 360)).toBe(true);
    expect(validation.items.slice(4).every((item: { width: number }) => item.width === manifest.output.width)).toBe(true);
  }, 30_000);

  it("binds review to image bytes and removes a stale release after replacement", async () => {
    const workDirectory = await approvedRun();
    const plan = await json(path.join(workDirectory, "plan.json"));
    await sharp({ create: { width: plan.output.width, height: plan.output.height, channels: 3, background: "#713529" } })
      .png().toFile(path.join(workDirectory, "raw", plan.jobs[0].fileName));
    const result = await runPipeline({ manifestPath: fixtureManifest, workDirectory, provider: "fixture" });
    expect(result.status).toBe("awaiting_approval");
    expect(result.counts.approved).toBe(7);
    await expect(access(path.join(workDirectory, "release-manifest.json"))).rejects.toThrow();
  }, 30_000);

  it("requires every planned decision, including missing records", async () => {
    const workDirectory = await approvedRun();
    const p = path.join(workDirectory, "approvals.json");
    const approvals = await json(p);
    delete approvals.decisions[Object.keys(approvals.decisions)[0]!];
    await writeFile(p, JSON.stringify(approvals));
    expect((await runPipeline({ manifestPath: fixtureManifest, workDirectory, provider: "fixture" })).status).toBe("awaiting_approval");
    await expect(access(path.join(workDirectory, "release-manifest.json"))).rejects.toThrow();
  }, 30_000);

  it("refuses approval when candidate bytes differ from validation", async () => {
    const workDirectory = await root();
    await runPipeline({ manifestPath: fixtureManifest, workDirectory, provider: "fixture" });
    const plan = await json(path.join(workDirectory, "plan.json"));
    await writeFile(path.join(workDirectory, "candidates", plan.jobs[0].fileName), "changed");
    await expect(approveAll(path.join(workDirectory, "approvals.json"))).rejects.toThrow("Candidate changed");
  }, 30_000);

  it("hashes reference contents and refuses to reuse a run after they change", async () => {
    const workDirectory = await root();
    const ref = path.join(workDirectory, "reference.png");
    await writeFile(ref, "first reference");
    const manifest = await json(fixtureManifest);
    for (const variant of manifest.variants) variant.references = [];
    manifest.variants[0].references = [ref];
    const manifestPath = path.join(workDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await loadManifestAndPlan(manifestPath);
    await runPipeline({ manifestPath, workDirectory, provider: "fixture" });
    await writeFile(ref, "second reference");
    const after = await loadManifestAndPlan(manifestPath);
    expect(after.plan.planHash).not.toBe(before.plan.planHash);
    expect(after.plan.jobs[0]!.fingerprint).not.toBe(before.plan.jobs[0]!.fingerprint);
    await expect(runPipeline({ manifestPath, workDirectory, provider: "fixture" })).rejects.toThrow("different plan or reference bytes");
  }, 30_000);

  it("rejects framing changes before creating a normalized candidate", async () => {
    const workDirectory = await root();
    const manifest = await json(fixtureManifest);
    for (const variant of manifest.variants) variant.references = [];
    manifest.output.preserveFraming = true;
    const manifestPath = path.join(workDirectory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await runPipeline({ manifestPath, workDirectory, provider: "fixture" });
    const plan = await json(path.join(workDirectory, "plan.json"));
    await sharp({ create: { width: 100, height: 300, channels: 3, background: "#556677" } }).png().toFile(path.join(workDirectory, "raw", plan.jobs[0].fileName));
    await expect(runPipeline({ manifestPath, workDirectory, provider: "fixture" })).rejects.toThrow("Framing mismatch");
  }, 30_000);
});

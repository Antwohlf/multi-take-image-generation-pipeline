import { access, copyFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationAdapter } from "./types.js";
import { writeJson } from "../core/io.js";

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const manualAdapter: GenerationAdapter = {
  name: "manual",
  async generate(context) {
    const inboxPath = path.join(context.inboxDirectory, context.job.fileName);
    if (await exists(inboxPath)) {
      await copyFile(inboxPath, context.destination);
      return { status: "imported" };
    }

    const requestPath = path.join(context.requestDirectory, `${context.job.id}.json`);
    await writeJson(requestPath, {
      version: 1,
      id: context.job.id,
      expectedFileName: context.job.fileName,
      prompt: context.job.prompt,
      promptHash: context.job.promptHash,
      fingerprint: context.job.fingerprint,
      references: context.job.references.map((reference) =>
        path.resolve(context.manifestDirectory, reference)),
      referenceHashes: context.job.referenceHashes,
      output: context.job.output,
      instructions: `Generate the image, preserve the supplied references where requested, and place the result at ${inboxPath}`,
    });
    return { status: "pending", requestPath };
  },
};

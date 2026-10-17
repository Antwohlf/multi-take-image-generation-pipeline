import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import type { GenerationAdapter } from "./types.js";
import { sleep } from "../core/io.js";

const isRetriable = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const status = "status" in error ? Number((error as { status?: number }).status) : 0;
  return status === 429 || status >= 500;
};

const imageMimeType = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
};

export const openAIAdapter: GenerationAdapter = {
  name: "openai",
  async generate(context) {
    if (!context.confirmCost) {
      throw new Error("OpenAI generation requires --confirm-cost");
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("Missing OPENAI_API_KEY");
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const referencePaths = context.job.references.map((reference) =>
      path.resolve(context.manifestDirectory, reference));
    const size = `${context.job.output.width}x${context.job.output.height}`;
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= context.plan.generation.retries) {
      attempt += 1;
      try {
        const response = referencePaths.length > 0
          ? await client.images.edit({
              model: context.plan.generation.model,
              image: await Promise.all(referencePaths.map(async (reference) =>
                toFile(createReadStream(reference), path.basename(reference), {
                  type: imageMimeType(reference),
                }))),
              prompt: context.job.prompt,
              quality: context.plan.generation.quality,
              size,
              output_format: context.job.output.format,
            })
          : await client.images.generate({
              model: context.plan.generation.model,
              prompt: context.job.prompt,
              quality: context.plan.generation.quality,
              size,
              output_format: context.job.output.format,
            });
        const encoded = response.data?.[0]?.b64_json;
        if (!encoded) throw new Error("OpenAI response did not include image bytes");
        await writeFile(context.destination, Buffer.from(encoded, "base64"));
        return { status: "generated" };
      } catch (error) {
        lastError = error;
        if (!isRetriable(error) || attempt > context.plan.generation.retries) throw error;
        await sleep(Math.max(1_000, context.plan.generation.delayMs) * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("OpenAI generation failed");
  },
};

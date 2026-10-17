import { z } from "zod";
import type { PipelineManifest } from "../types.js";

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const outputSchema = z.object({
    width: z.number().int().min(64).max(3840),
    height: z.number().int().min(64).max(3840),
    fit: z.enum(["cover", "contain", "fill"]).default("cover"),
    preserveFraming: z.boolean().optional(),
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
  });

const manifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  variants: z.array(
    z.object({
      output: outputSchema.optional(),
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
      references: z.array(z.string()).default([]),
      variables: z.record(z.string(), scalar).default({}),
    }),
  ).min(1),
  axes: z.record(z.string(), z.array(scalar).min(1)).default({}),
  promptTemplate: z.string().min(1),
  namingTemplate: z.string().min(1).default("{{id}}.png"),
  output: outputSchema,
  generation: z.object({
    provider: z.enum(["fixture", "manual", "openai"]).default("manual"),
    model: z.string().min(1).default("gpt-image-2-2026-04-21"),
    quality: z.enum(["low", "medium", "high", "auto"]).default("high"),
    retries: z.number().int().min(0).max(8).default(3),
    delayMs: z.number().int().min(0).max(60_000).default(500),
  }).default({
    provider: "manual",
    model: "gpt-image-2-2026-04-21",
    quality: "high",
    retries: 3,
    delayMs: 500,
  }),
  approval: z.object({
    requireAll: z.boolean().default(true),
  }).default({ requireAll: true }),
});

export const parseManifest = (value: unknown): PipelineManifest =>
  manifestSchema.parse(value) as PipelineManifest;

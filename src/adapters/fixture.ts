import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import type { GenerationAdapter } from "./types.js";

const xmlEscape = (value: string): string =>
  value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;",
  })[character] ?? character);

export const fixtureAdapter: GenerationAdapter = {
  name: "fixture",
  async generate({ job, destination }) {
    const hueA = Number.parseInt(job.fingerprint.slice(0, 4), 16) % 360;
    const hueB = (hueA + 75) % 360;
    const subtitle = Object.entries(job.variables)
      .filter(([key]) => key !== "id")
      .map(([key, value]) => `${key}: ${value}`)
      .join("  •  ");
    const svg = `
      <svg width="${job.output.width}" height="${job.output.height}" viewBox="0 0 ${job.output.width} ${job.output.height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="hsl(${hueA}, 65%, 34%)" />
            <stop offset="1" stop-color="hsl(${hueB}, 72%, 18%)" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#background)" />
        <circle cx="78%" cy="30%" r="22%" fill="rgba(255,255,255,.12)" />
        <path d="M0 ${job.output.height * 0.75} Q ${job.output.width * 0.25} ${job.output.height * 0.5}, ${job.output.width * 0.5} ${job.output.height * 0.76} T ${job.output.width} ${job.output.height * 0.64} V ${job.output.height} H0Z" fill="rgba(0,0,0,.24)" />
        <text x="7%" y="76%" fill="white" font-family="Arial, sans-serif" font-size="64" font-weight="700">${xmlEscape(job.id)}</text>
        <text x="7%" y="84%" fill="rgba(255,255,255,.78)" font-family="Arial, sans-serif" font-size="26">${xmlEscape(subtitle)}</text>
        <text x="7%" y="91%" fill="rgba(255,255,255,.56)" font-family="monospace" font-size="18">fixture ${job.fingerprint.slice(0, 12)}</text>
      </svg>`;
    const image = await sharp(Buffer.from(svg)).png().toBuffer();
    await writeFile(destination, image);
    return { status: "generated" };
  },
};
